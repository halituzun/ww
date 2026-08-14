import { randomUUID } from 'node:crypto';
import { canonicalJsonV1, canonicalSha256V1 } from '@ww/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCh, type ClickHouseClient } from '../client.js';
import { runMigrations } from '../migrate.js';
import { clickhouseUp } from '../testutil.js';
import {
  appendAssignmentAttempt,
  appendPromptInputSnapshot,
  appendTaskBrief,
  appendTaskHandoff,
  getAssignmentAttempt,
  getPromptInputSnapshot,
  getTaskBrief,
  getTaskHandoff,
} from './briefs.js';
import {
  RepositoryConflictError,
  RepositoryWriteError,
  type AcknowledgedWriteVerificationCause,
} from './types.js';

const up = await clickhouseUp();

describe.skipIf(!up)('immutable brief repositories', () => {
  const db = `ww_test_briefs_${Date.now()}_${process.pid}`;
  let ch: ClickHouseClient;
  beforeAll(async () => {
    await runMigrations({ database: db });
    ch = createCh({ database: db });
  });
  afterAll(async () => {
    const admin = createCh({ database: 'default' });
    await admin.command({ query: `DROP DATABASE IF EXISTS ${db}` });
    await admin.close();
    await ch.close();
  });

  function fixtures() {
    const id = {
      project: randomUUID(), task: randomUUID(), brief: randomUUID(), plan: randomUUID(),
      context: randomUUID(), attempt: randomUUID(), worker: randomUUID(), verifier: randomUUID(),
      invocation: randomUUID(), snapshot: randomUUID(), handoff: randomUUID(), nextAttempt: randomUUID(),
      artifact: randomUUID(), question: randomUUID(), receipt: randomUUID(),
    };
    const hash = 'a'.repeat(64);
    const planSource = { sourceType: 'plan' as const, sourceId: id.plan, version: 1, hash };
    const promptSource = { sourceType: 'prompt' as const, sourceId: 'role.worker.coding', version: 2, hash };
    const ruleSource = { sourceType: 'rule' as const, sourceId: 'COMM-001', version: 1, hash };
    const brief = {
      contractVersion: 1 as const, taskBriefId: id.brief, taskBriefVersion: 1,
      projectId: id.project, taskId: id.task, taskVersion: 2, planId: id.plan,
      planVersion: 1, planHash: hash, goal: 'Implement durable repositories',
      acceptanceCriteria: ['Persists exactly'], dependencyTaskIds: [], targetFiles: ['x.ts'],
      allowedTools: ['read_file'], tokenBudget: 1000, promptRefs: [promptSource],
      ruleRefs: [{ ruleId: 'COMM-001' as const, ruleVersion: 1, hash }],
      standardRefs: [], contextSnapshotId: id.context,
      baseContextCutoffAt: '2026-08-14T10:00:00.000Z',
      sourceVersionManifest: [planSource, promptSource, ruleSource],
      verificationMode: 'required' as const, sealedAt: '2026-08-14T10:01:00.000Z',
    };
    const attempt = {
      contractVersion: 1 as const, assignmentAttemptId: id.attempt, projectId: id.project,
      taskId: id.task, taskBriefId: id.brief, attemptNumber: 1, workerAgentId: id.worker,
      verifierAgentId: id.verifier, leaseOwner: 'scheduler-1', leaseFence: 1,
      leaseExpiresAt: '2026-08-14T10:10:00.000Z', startReason: 'initial' as const,
      assignedAt: '2026-08-14T10:02:00.000Z',
    };
    const promptMessages = [{ role: 'system' as const, content: 'System prompt' }];
    const snapshot = {
      contractVersion: 1 as const, promptInputSnapshotId: id.snapshot,
      invocationId: id.invocation, projectId: id.project, taskId: id.task,
      taskBriefId: id.brief, assignmentAttemptId: id.attempt,
      inputTaskCausalCursor: { assignmentAttemptId: id.attempt, ordinal: 0 },
      sourceVersionManifest: [planSource], promptMessages,
      promptHash: canonicalSha256V1(promptMessages), sealedAt: '2026-08-14T10:03:00.000Z',
    };
    const handoff = {
      contractVersion: 1 as const, handoffId: id.handoff, projectId: id.project,
      taskId: id.task, taskBriefId: id.brief, fromAssignmentAttemptId: id.attempt,
      toAssignmentAttemptId: id.nextAttempt,
      ancestorCursor: { assignmentAttemptId: id.attempt, ordinal: 0 },
      artifactIds: [id.artifact], evidenceRefs: ['event:1'],
      pendingQuestionMessageIds: [id.question], pendingReceiptIds: [id.receipt],
      workspaceCheckpoint: { changedPaths: ['x.ts'] },
      leaseRelease: { status: 'released' as const, leaseOwner: 'scheduler-1', leaseFence: 1 },
      lockRelease: { releasedLockKeys: ['file:x.ts'], failedLockKeys: [] },
      createdAt: '2026-08-14T10:04:00.000Z',
    };
    return { brief, attempt, snapshot, handoff };
  }

  it('dort immutable contracti strict schema ve kolon fidelity ile round-trip eder', async () => {
    const values = fixtures();
    await appendTaskBrief(ch, values.brief);
    await appendAssignmentAttempt(ch, values.attempt);
    await appendPromptInputSnapshot(ch, values.snapshot);
    await appendTaskHandoff(ch, values.handoff);
    expect(await getTaskBrief(ch, values.brief.taskBriefId)).toEqual(values.brief);
    expect(await getAssignmentAttempt(ch, values.attempt.assignmentAttemptId)).toEqual(values.attempt);
    expect(await getPromptInputSnapshot(ch, values.snapshot.promptInputSnapshotId)).toEqual(values.snapshot);
    expect(await getTaskHandoff(ch, values.handoff.handoffId)).toEqual(values.handoff);

    const raw = await ch.query({
      query: `SELECT prompt_messages_json FROM prompt_input_snapshots
        WHERE prompt_input_snapshot_id = {id:UUID}`,
      query_params: { id: values.snapshot.promptInputSnapshotId },
      format: 'JSONEachRow',
    });
    expect((await raw.json<{ prompt_messages_json: string }>())[0]?.prompt_messages_json).toBe(
      canonicalJsonV1(values.snapshot.promptMessages),
    );
  });

  it('ayni immutable kimlikte farkli contract hashini reddeder', async () => {
    const { brief } = fixtures();
    await appendTaskBrief(ch, brief);
    await expect(appendTaskBrief(ch, { ...brief, goal: 'Different valid goal' })).rejects.toBeInstanceOf(
      RepositoryConflictError,
    );
  });

  it('adapter kabul ettikten sonra hata atarsa deterministic reread ile uzlastirir', async () => {
    const { brief } = fixtures();
    let thrown = false;
    const uncertain = new Proxy(ch, {
      get(target, property) {
        if (property === 'insert') return async (options: Parameters<ClickHouseClient['insert']>[0]) => {
          await target.insert(options);
          if (!thrown) {
            thrown = true;
            throw new Error('simulated timeout after accept');
          }
        };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    expect(await appendTaskBrief(uncertain, brief)).toEqual(brief);
  });

  it('immutable post-ack read hatasini typed verir ve exact retry kalici contracti bulur', async () => {
    const { brief } = fixtures();
    const verification = new Error('brief verification unavailable');
    let failNextQuery = false;
    const acknowledged = new Proxy(ch, {
      get(target, property) {
        if (property === 'insert') return async (options: Parameters<ClickHouseClient['insert']>[0]) => {
          await target.insert(options);
          failNextQuery = true;
        };
        if (property === 'query') return (options: Parameters<ClickHouseClient['query']>[0]) => {
          if (failNextQuery) {
            failNextQuery = false;
            throw verification;
          }
          return target.query(options);
        };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const failure = await appendTaskBrief(acknowledged, brief).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RepositoryWriteError);
    const cause = (failure as RepositoryWriteError).cause as AcknowledgedWriteVerificationCause;
    expect(cause).toMatchObject({ commitLikely: true, verification });
    expect(await appendTaskBrief(ch, brief)).toEqual(brief);
  });
});
