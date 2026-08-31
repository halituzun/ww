import { randomUUID } from 'node:crypto';
import {
  appendKnowledgeVersion,
  createProjectMapSnapshot,
  createCh,
  createPlan,
  createTask,
  runMigrations,
  type ClickHouseClient,
} from '@ww/db';
import { NIL_UUID, canonicalSha256V1 } from '@ww/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TaskContextSnapshotBuilder } from './task-context-snapshot-builder.js';

async function clickhouseAvailable(): Promise<boolean> {
  const probe = createCh({ database: 'default' });
  try {
    const result = await probe.query({ query: 'SELECT 1', format: 'JSONEachRow' });
    await result.json();
    return true;
  } catch (error) {
    if (process.env['WW_REQUIRE_INTEGRATION'] === '1') {
      throw new Error('WW_REQUIRE_INTEGRATION=1 ancak ClickHouse kullanilamiyor', {
        cause: error,
      });
    }
    return false;
  } finally {
    await probe.close();
  }
}

const up = await clickhouseAvailable();

describe.skipIf(!up)('TaskContextSnapshotBuilder ClickHouse integration', () => {
  const database = `ww_test_memory_snapshot_${Date.now()}_${process.pid}`;
  let ch: ClickHouseClient;

  beforeAll(async () => {
    await runMigrations({ database });
    ch = createCh({ database });
  });

  afterAll(async () => {
    const admin = createCh({ database: 'default' });
    await admin.command({ query: `DROP DATABASE IF EXISTS ${database}` });
    await admin.close();
    await ch.close();
  });

  async function taskPlanSources(projectId: string, createdAt: string) {
    const planId = randomUUID();
    const taskId = randomUUID();
    const issuerAgentId = randomUUID();
    const plan = await createPlan(ch, {
      plan_id: planId,
      project_id: projectId,
      plan_version: 1,
      status: 'approved',
      title: 'Snapshot plan',
      content_md: '# Snapshot',
      council_session_id: NIL_UUID,
      team_json: {},
      scenarios_json: [],
      replan_reason: '',
      supersedes_plan_id: NIL_UUID,
      created_by_agent_id: issuerAgentId,
      approved_by: 'test',
      created_at: createdAt,
    });
    const task = await createTask(ch, {
      task_id: taskId,
      project_id: projectId,
      plan_id: planId,
      parent_task_id: NIL_UUID,
      title: 'Snapshot task',
      description: 'Build snapshot',
      status: 'queued',
      priority: 1,
      issuer_agent_id: issuerAgentId,
      worker_agent_id: NIL_UUID,
      verifier_agent_id: NIL_UUID,
      group: 'coding',
      depends_on: [],
      target_files: [],
      attempt: 0,
      max_attempts: 3,
      delegation_depth: 0,
      token_budget: 1_000,
      tokens_spent: '0',
      commit_hash: '',
      result_summary: '',
      reject_reason: '',
      task_brief_id: NIL_UUID,
      assignment_attempt_id: NIL_UUID,
      created_at: createdAt,
      updated_at: createdAt,
    });
    return {
      taskSource: {
        sourceType: 'task' as const,
        sourceId: task.task_id,
        version: Number(task.version),
        hash: canonicalSha256V1(task),
      },
      planSource: {
        sourceType: 'plan' as const,
        sourceId: plan.plan_id,
        version: plan.plan_version,
        hash: canonicalSha256V1(plan),
      },
    };
  }

  it('prompt ve knowledge kaynaklarini tam cutoff anindan secip manifesti deterministik muhurluyor', async () => {
    const projectId = randomUUID();
    const knowledgeId = randomUUID();
    const sources = await taskPlanSources(projectId, new Date().toISOString());
    const initial = await appendKnowledgeVersion(ch, {
      knowledge_id: knowledgeId,
      project_id: projectId,
      kind: 'standard',
      title: 'Repository standard',
      content: 'Use append-only state.',
      tags: ['scheduler'],
      source_task_id: NIL_UUID,
      source_message_id: NIL_UUID,
      status: 'active',
      superseded_by: NIL_UUID,
      created_at: new Date().toISOString(),
    });
    const cutoffAt = initial.observed_at;
    const projectMap = await createProjectMapSnapshot(ch, {
      project_map_id: randomUUID(),
      project_id: projectId,
      map_json: {
        fileCount: 1,
        functionCount: 1,
        routeCount: 1,
        files: [{ filePath: 'src/api.controller.ts' }],
      },
      file_count: 1,
      function_count: 1,
      route_count: 1,
      generated_at: initial.created_at,
      created_at: initial.created_at,
    });
    await appendKnowledgeVersion(ch, {
      ...initial,
      content: 'A later standard must not leak into the snapshot.',
      created_at: new Date(Date.parse(initial.created_at) + 1).toISOString(),
    }, initial.version);

    const hash = canonicalSha256V1('fixture');
    const input = {
      projectId,
      taskSource: sources.taskSource,
      planSource: sources.planSource,
      prompts: [
        { name: 'role.worker.coding', version: 2 },
        { name: 'role.verifier', version: 1 },
        { name: 'role.verifier', version: 1 },
      ],
      rules: [{ ruleId: 'TASK-001' as const, ruleVersion: 1, hash }],
      standardKnowledgeIds: [knowledgeId],
      requirementKnowledgeIds: [],
      cutoffAt,
    };
    const builder = new TaskContextSnapshotBuilder(ch);
    const first = await builder.build(input);
    const replay = await builder.build(input);

    await expect(builder.build({
      ...input,
      taskSource: { ...input.taskSource, hash: canonicalSha256V1('forged-task') },
    })).rejects.toThrow(/taskSource repository\/cutoff ile eslesmiyor/);
    await expect(builder.build({
      ...input,
      planSource: { ...input.planSource, hash: canonicalSha256V1('forged-plan') },
    })).rejects.toThrow(/planSource repository\/cutoff ile eslesmiyor/);

    expect(replay).toEqual(first);
    expect(first.promptRefs.map((ref) => `${ref.sourceId}@${ref.version}`)).toEqual([
      'role.worker.coding@2',
      'role.verifier@1',
    ]);
    expect(first.standardRefs).toHaveLength(1);
    expect(first.standardRefs[0]).toMatchObject({
      sourceType: 'standard',
      sourceId: knowledgeId,
      version: Number(initial.version),
    });
    expect(first.sourceVersionManifest.map((ref) => ref.sourceType)).toEqual([
      'task',
      'plan',
      'prompt',
      'prompt',
      'rule',
      'standard',
      'project_map',
    ]);
    expect(first.sourceVersionManifest).toContainEqual({
      sourceType: 'project_map',
      sourceId: projectMap.project_map_id,
      version: Number(projectMap.version),
      hash: canonicalSha256V1(projectMap),
    });
  });

  it('cutoff aninda bulunmayan kaynagi fail-closed reddediyor', async () => {
    const projectId = randomUUID();
    const cutoffAt = new Date(Date.now() + 60_000).toISOString();
    const sources = await taskPlanSources(projectId, new Date().toISOString());
    await expect(new TaskContextSnapshotBuilder(ch).build({
      projectId,
      taskSource: sources.taskSource,
      planSource: sources.planSource,
      prompts: [{ name: 'role.worker.coding', version: 2 }],
      rules: [],
      standardKnowledgeIds: [randomUUID()],
      requirementKnowledgeIds: [],
      cutoffAt,
    })).rejects.toThrow(/as-of standard bulunamadi/);
  });

  it('knowledge kimligini standard veya requirement diye yanlis etiketlemeyi reddediyor', async () => {
    const projectId = randomUUID();
    const decisionId = randomUUID();
    await appendKnowledgeVersion(ch, {
      knowledge_id: decisionId,
      project_id: projectId,
      kind: 'decision',
      title: 'Not a standard',
      content: 'This row must not gain standard authority.',
      tags: ['scheduler'],
      source_task_id: NIL_UUID,
      source_message_id: NIL_UUID,
      status: 'active',
      superseded_by: NIL_UUID,
      created_at: new Date().toISOString(),
    });
    const sources = await taskPlanSources(projectId, new Date().toISOString());
    const cutoffAt = new Date(Date.now() + 60_000).toISOString();
    await expect(new TaskContextSnapshotBuilder(ch).build({
      projectId,
      taskSource: sources.taskSource,
      planSource: sources.planSource,
      prompts: [{ name: 'role.worker.coding', version: 2 }],
      rules: [],
      standardKnowledgeIds: [decisionId],
      requirementKnowledgeIds: [],
      cutoffAt,
    })).rejects.toThrow(/knowledge turu standard degil/);
  });
});
