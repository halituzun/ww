import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createAgent,
  createCh,
  appendPromptVersion,
  createPlan,
  createProject,
  createTask,
  createRedis,
  enqueueTask,
  getLatestTask,
  runMigrations,
  type ClickHouseClient,
  type WwRedis,
} from '@ww/db';
import { canonicalSha256V1 } from '@ww/shared';
import { NIL_UUID } from '@ww/shared';
import { systemPrincipal, TaskTransitionService } from '@ww/scheduler';
import { MockProvider, chUsageSink } from '@ww/providers';
import {
  DockerSandboxAdapter,
  CommandRunner,
  DurableExecutorAudit,
  DurableExecutorIntent,
  DurableGateCommitAudit,
  clickHouseExecutorEventStore,
  dbRedisExecutorAccess,
  WorkspacePaths,
} from '@ww/executor';
import { createPhase9RuntimeComposition } from './runtime-composition.js';

const required = process.env['WW_REQUIRE_INTEGRATION'] === '1';
let probe: ClickHouseClient | undefined;
let probeRedis: WwRedis | undefined;
try {
  probe = createCh();
  await probe.query({ query: 'SELECT 1', format: 'JSONEachRow' });
  probeRedis = await createRedis();
} catch (error) {
  if (required) throw error;
}

describe.skipIf(probe === undefined || probeRedis === undefined)('Phase 9 runtime composition', () => {
  let ch: ClickHouseClient;
  let redis: WwRedis;
  const database = `ww_phase9_runtime_${Date.now()}_${process.pid}`;

  beforeAll(async () => {
    await runMigrations({ database });
    ch = createCh({ database });
    redis = await createRedis();
  });

  afterAll(async () => {
    redis.destroy();
    await ch.close();
    const admin = createCh({ database: 'default' });
    await admin.command({ query: `DROP DATABASE IF EXISTS ${database}` });
    await admin.close();
    probeRedis?.destroy();
    await probe?.close();
  });

  it('project→task→queue ve durable provider invocation akışını kurar', async () => {
    const projectId = randomUUID();
    const now = new Date().toISOString();
    await createProject(ch, {
      project_id: projectId,
      name: 'Phase 9 runtime',
      slug: `phase9-${projectId.slice(0, 8)}`,
      type: 'web',
      status: 'draft',
      description: '',
      workspace_path: `workspace/${projectId}`,
      budget_usd_limit: 10,
      settings: {},
      active_plan_id: '00000000-0000-0000-0000-000000000000',
      created_at: now,
      updated_at: now,
    });
    const pmId = randomUUID();
    const workerId = randomUUID();
    const verifierId = randomUUID();
    const planId = randomUUID();
    await createAgent(ch, {
      agent_id: pmId,
      project_id: projectId,
      role: 'pm',
      group: 'management',
      name: 'Phase 9 PM',
      model_ref: 'mock:smoke',
      parent_agent_id: '00000000-0000-0000-0000-000000000000',
      clone_of: '00000000-0000-0000-0000-000000000000',
      status: 'idle',
      current_task_id: '00000000-0000-0000-0000-000000000000',
      prompt_name: 'role.pm',
      prompt_version: 1,
      tasks_done: 0,
      tasks_rejected: 0,
      created_at: now,
      updated_at: now,
    });
    for (const agent of [
      { id: workerId, role: 'worker' as const, name: 'Phase 9 worker', model: 'mock:worker' },
      { id: verifierId, role: 'verifier' as const, name: 'Phase 9 verifier', model: 'mock:verifier' },
    ]) {
      await createAgent(ch, {
        agent_id: agent.id,
        project_id: projectId,
        role: agent.role,
        group: 'coding',
        name: agent.name,
        model_ref: agent.model,
        parent_agent_id: NIL_UUID,
        clone_of: NIL_UUID,
        status: 'idle',
        current_task_id: NIL_UUID,
        prompt_name: `phase9.${projectId}.${agent.role}`,
        prompt_version: 1,
        tasks_done: 0,
        tasks_rejected: 0,
        created_at: now,
        updated_at: now,
      });
    }
    await createPlan(ch, {
      plan_id: planId,
      project_id: projectId,
      plan_version: 1,
      status: 'approved',
      title: 'Phase 9 approved plan',
      content_md: '# Phase 9 plan',
      council_session_id: NIL_UUID,
      team_json: {},
      scenarios_json: [],
      replan_reason: '',
      supersedes_plan_id: NIL_UUID,
      created_by_agent_id: pmId,
      approved_by: 'phase9-test',
      created_at: now,
    });
    await appendPromptVersion(ch, {
      prompt_name: `phase9.${projectId}.worker`,
      prompt_version: 1,
      content: 'You are a worker.',
      variables: [],
      changelog: 'Phase 9 fixture',
      is_active: true,
      created_at: now,
    });
    await appendPromptVersion(ch, {
      prompt_name: `phase9.${projectId}.verifier`,
      prompt_version: 1,
      content: 'You are an independent verifier.',
      variables: [],
      changelog: 'Phase 9 fixture',
      is_active: true,
      created_at: now,
    });

    const taskId = randomUUID();
    await createTask(ch, {
      task_id: taskId,
      project_id: projectId,
      plan_id: planId,
      parent_task_id: NIL_UUID,
      title: 'Phase 9 assigned task',
      description: 'real repository assignment fixture',
      acceptance_criteria: ['gate passes'],
      status: 'queued',
      priority: 5,
      issuer_agent_id: pmId,
      worker_agent_id: NIL_UUID,
      verifier_agent_id: NIL_UUID,
      group: 'coding',
      depends_on: [],
      target_files: ['src/phase9.ts'],
      attempt: 0,
      max_attempts: 3,
      delegation_depth: 0,
      token_budget: 1000,
      tokens_spent: '0',
      commit_hash: '',
      result_summary: '',
      reject_reason: '',
      task_brief_id: NIL_UUID,
      assignment_attempt_id: NIL_UUID,
      created_at: now,
      updated_at: now,
    });
    await enqueueTask(redis, `ww:queue:${projectId}`, taskId);
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'ww-phase9-workspace-'));
    await mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
    await writeFile(path.join(workspaceRoot, 'src/phase9.ts'), 'export const phase9 = true;\n');
    await writeFile(path.join(workspaceRoot, 'ww.gate.json'), JSON.stringify({
      version: 1,
      inputs: ['src/phase9.ts'],
      discardedOutputs: [],
      steps: [{ name: 'node-check', command: 'node', args: ['-e', 'process.exit(0)'] }],
    }));
    const host = new CommandRunner();
    await host.run({ projectKey: projectId, command: 'git', args: ['init', '-q'], cwd: workspaceRoot });
    await host.run({ projectKey: projectId, command: 'git', args: ['config', 'user.email', 'phase9@example.test'], cwd: workspaceRoot });
    await host.run({ projectKey: projectId, command: 'git', args: ['config', 'user.name', 'Phase 9'], cwd: workspaceRoot });
    const provider = new MockProvider({ script: [{ content: 'runtime-ok', toolCalls: [] }] });
    const failClosed = async () => { throw new Error('Phase 9 operation requires orchestration wiring'); };
    const transition = new TaskTransitionService(ch, redis);
    const rawStore = clickHouseExecutorEventStore(ch);
    const store = {
      ...rawStore,
      append: async (event: Parameters<typeof rawStore.append>[0]) => {
        try { return await rawStore.append(event); } catch (error) { console.error('phase9-audit-store-error', error); throw error; }
      },
    };
    const composition = createPhase9RuntimeComposition({
      projectId: projectId as never,
      consumerId: 'phase9-runtime-test',
      ch,
      redis,
      providers: new Map([['mock', provider]]),
      fallbacks: () => [],
      internalAuthentication: { type: 'internal_service', credential: 'phase9', issuedAt: now },
      providerContext: { sessionId: randomUUID() as never, owningPmId: pmId as never },
      usageSink: chUsageSink(ch),
      snapshotBuilder: {
        build: async (input: Readonly<{ taskSource: { sourceType: 'task'; sourceId: string; version: number; hash: string }; planSource: { sourceType: 'plan'; sourceId: string; version: number; hash: string }; prompts: readonly { name: string; version: number }[]; rules: readonly unknown[]; cutoffAt: string }>) => {
          const promptRefs = input.prompts.map((prompt) => ({
            sourceType: 'prompt' as const,
            sourceId: prompt.name,
            version: prompt.version,
            hash: canonicalSha256V1(prompt),
          }));
          const ruleRefs = input.rules as readonly { ruleId: string; ruleVersion: number; hash: string }[];
          return {
            contextSnapshotId: randomUUID(),
            baseContextCutoffAt: input.cutoffAt,
            promptRefs,
            ruleRefs,
            standardRefs: [],
            requirementRefs: [],
            sourceVersionManifest: [input.taskSource, input.planSource, ...promptRefs, ...ruleRefs.map((rule) => ({ sourceType: 'rule' as const, sourceId: rule.ruleId, version: rule.ruleVersion, hash: rule.hash }))],
          };
        },
      } as never,
      schedulerOperations: {
        awaitUserAnswer: failClosed,
        resumeUserAnswer: failClosed,
        handleExecutionError: async ({ error }) => {
          console.error('phase9-orchestrator-error', error);
          return 'failed';
        },
        transition: async ({ taskId: currentTaskId, attempt, action, evidenceRefs }) => {
          // TaskTransitionService owns the short command lease. Gate/commit
          // reacquire their own fenced task lease through the production
          // scheduler composition; this fixture must not fake a heartbeat.
          const common = {
            protocolVersion: 1 as const,
            transitionRequestId: randomUUID(),
            projectId,
            taskId: currentTaskId,
            taskBriefId: attempt.taskBriefId,
            assignmentAttemptId: attempt.assignmentAttemptId,
            causationId: randomUUID(),
            requestedAt: new Date().toISOString(),
          };
          const request = action === 'start_work' || action === 'gate_passed'
            ? { ...common, action }
            : action === 'report_result'
              ? { ...common, action, resultSummary: 'Phase 9 worker report', evidenceRefs: evidenceRefs ?? [] }
              : action === 'verifier_approved'
                ? { ...common, action, verdictMessageId: randomUUID() }
                : { ...common, action: 'commit_completed' as const, commitHash: (evidenceRefs ?? [])[0] ?? '0000000', artifactIds: [] };
          const state = await transition.apply(systemPrincipal('phase9-e2e', common.requestedAt), request as never);
          return { status: state.status };
        },
        reassign: failClosed,
        escalate: failClosed,
        gate: async () => {
          const workspace = await new WorkspacePaths(workspaceRoot).initialize();
          const evidence = await compositionGate.run(projectId, workspace, {
            operationId: randomUUID(),
            occurredAt: new Date(Date.now() + 10_000).toISOString(),
          });
          return { passed: evidence.passed, evidenceRefs: ['ww.gate.json'] };
        },
        commit: async ({ taskId: currentTaskId, attempt }) => {
          const workspace = await new WorkspacePaths(workspaceRoot).initialize();
          const result = await compositionGit.commitAfterSuccessfulGate(workspace, {
            projectKey: projectId,
            operationId: randomUUID(),
            occurredAt: new Date(Date.now() + 20_000).toISOString(),
            taskId: currentTaskId,
            title: 'Phase 9 E2E',
            summary: 'Real Phase 9 runtime composition commit',
            workerName: 'Phase 9 worker',
            verifierName: 'Phase 9 verifier',
            targetFiles: ['src/phase9.ts'],
            targetAccess: [{ projectId, taskId: currentTaskId, taskBriefId: attempt.taskBriefId, assignmentAttemptId: attempt.assignmentAttemptId, agentId: attempt.workerAgentId, taskStatus: 'approved', leaseOwner: attempt.leaseOwner, leaseFence: attempt.leaseFence, relativePath: 'src/phase9.ts', requireFileLock: true }],
          });
          return { commitHash: result.commitHash, artifactIds: [randomUUID()] };
        },
      },
      orchestrationRuntime: {
        work: async () => ({ kind: 'report' as const, summary: 'Phase 9 worker report' }),
        verify: async () => ({ verdict: { decision: 'approve' as const, evidenceRefs: ['phase9-verifier'] }, diff: 'diff --git a/src/phase9.ts b/src/phase9.ts' }),
      },
      localSessionToken: 'phase9-test-token',
      executor: {
        sandbox: new DockerSandboxAdapter({ image: process.env['WW_EXECUTOR_IMAGE'] ?? 'ww-executor-runtime:local' }),
        gateAudit: new DurableGateCommitAudit(store),
        gateInputPolicy: { assertAllowed: async () => undefined },
        hostCommand: new CommandRunner(),
        access: dbRedisExecutorAccess(ch, redis),
        communication: { askQuestion: failClosed, reportResult: failClosed, submitVerdict: failClosed },
        audit: new DurableExecutorAudit(store),
        effects: { run: failClosed },
        intents: new DurableExecutorIntent(store),
        sandboxInputs: { resolveTrustedInputs: failClosed },
      },
    });
    const compositionGate = composition.gateRunner;
    const compositionGit = composition.gitWorkspace;
    const assigned = await composition.assignmentService.assign(taskId as never);
    expect(assigned.workerAgentId).toBe(workerId);
    expect(assigned.verifierAgentId).toBe(verifierId);
    expect((await getLatestTask(ch, projectId, taskId))?.assignment_attempt_id).toBe(assigned.assignmentAttemptId);

    const brief = await composition.taskBriefService.seal({
      taskId: taskId as never,
      workerPrompt: { name: `phase9.${projectId}.worker`, version: 1 },
      verifierPrompt: { name: `phase9.${projectId}.verifier`, version: 1 },
      allowedTools: [],
      cutoffAt: new Date().toISOString(),
    });
    expect(brief.taskId).toBe(taskId);

    const orchestrated = await composition.orchestrate({ taskId: taskId as never, brief, maxAttempts: 1 });
    expect(orchestrated.status).toBe('done');
    expect(orchestrated.commitHash).toMatch(/^[a-f0-9]{40}$/);

    const result = await composition.router.complete('mock:smoke', {
      messages: [],
      meta: {
        projectId,
        agentId: pmId,
        taskId,
        purpose: 'completion',
        invocationId: randomUUID(),
        taskBriefId: randomUUID(),
        assignmentAttemptId: assigned.assignmentAttemptId,
        promptInputSnapshotId: randomUUID(),
      },
    });
    expect(result.result.content).toBe('runtime-ok');
    expect(provider.calls).toHaveLength(1);
    expect(composition.inboxPollingModule).toBeDefined();
  });
});
