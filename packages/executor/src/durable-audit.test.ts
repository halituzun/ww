import { randomUUID } from 'node:crypto';
import type { AppendEventInput, EventRow } from '@ww/db';
import { EntityIdSchema, canonicalSha256V1 } from '@ww/shared';
import { describe, expect, it } from 'vitest';
import {
  DurableExecutorAudit,
  DurableExecutorIntent,
  DurableGateCommitAudit,
  type ExecutorEventStorePort,
} from './durable-audit.js';
import type { ExecutorAuditEvent, ExecutorToolIntent } from './ports.js';

const id = () => EntityIdSchema.parse(randomUUID());
const occurredAt = '2026-08-15T10:00:00.000Z';

class EventStoreFake implements ExecutorEventStorePort {
  readonly rows = new Map<string, EventRow>();
  loseNextAppendResponse = false;

  async get(eventId: ReturnType<typeof id>): Promise<EventRow | null> {
    return this.rows.get(eventId) ?? null;
  }

  async append(event: AppendEventInput): Promise<EventRow> {
    const current = this.rows.get(event.event_id);
    if (current !== undefined && canonicalSha256V1(current) !== canonicalSha256V1(event)) {
      throw new Error('immutable collision');
    }
    this.rows.set(event.event_id, event);
    if (this.loseNextAppendResponse) {
      this.loseNextAppendResponse = false;
      throw new Error('accepted then response lost');
    }
    return event;
  }
}

function intent(overrides: Partial<ExecutorToolIntent> = {}): ExecutorToolIntent {
  return {
    callId: id(),
    toolName: 'write_file',
    projectId: id(),
    taskId: id(),
    taskBriefId: id(),
    assignmentAttemptId: id(),
    agentId: id(),
    leaseOwner: 'scheduler:test',
    leaseFence: 7,
    argsHash: 'a'.repeat(64),
    requestHash: 'b'.repeat(64),
    occurredAt,
    ...overrides,
  };
}

describe('durable executor audit adapters', () => {
  it('executor audit accepted-then-throw yazısını exact read-after-write ile uzlaştırır', async () => {
    const store = new EventStoreFake();
    store.loseNextAppendResponse = true;
    const audit = new DurableExecutorAudit(store);
    const event: ExecutorAuditEvent = {
      eventId: id(),
      projectId: id(),
      taskId: id(),
      assignmentAttemptId: id(),
      agentId: id(),
      eventType: 'tool_call',
      toolCallId: id(),
      toolName: 'write_file',
      occurredAt,
      payload: { keys: ['content', 'path'], argumentCount: 2 },
    };
    await expect(audit.append(event)).resolves.toBeUndefined();
    await expect(audit.append(event)).resolves.toBeUndefined();
    expect(store.rows).toHaveLength(1);
  });

  it('aynı audit eventId altındaki divergent immutable payloadı reddeder', async () => {
    const store = new EventStoreFake();
    const audit = new DurableExecutorAudit(store);
    const event: ExecutorAuditEvent = {
      eventId: id(), projectId: id(), taskId: id(), assignmentAttemptId: id(), agentId: id(),
      eventType: 'tool_result', toolCallId: id(), toolName: 'read_file', occurredAt,
      payload: { ok: true },
    };
    await audit.append(event);
    await expect(audit.append({ ...event, payload: { ok: false } }))
      .rejects.toMatchObject({ code: 'AUDIT_FAILED' });
  });

  it('tool intent/completionı exact call kimliğine bağlar ve lost responseu reconcile eder', async () => {
    const store = new EventStoreFake();
    const ledger = new DurableExecutorIntent(store);
    const value = intent();
    store.loseNextAppendResponse = true;
    await expect(ledger.accept(value)).resolves.toEqual({ state: 'uncertain' });
    await expect(ledger.accept(value)).resolves.toEqual({ state: 'replay' });
    await expect(ledger.accept({ ...value, argsHash: 'c'.repeat(64) }))
      .rejects.toMatchObject({ code: 'CALL_INTENT_CONFLICT' });
    await expect(ledger.accept({ ...value, requestHash: 'c'.repeat(64) }))
      .rejects.toMatchObject({ code: 'CALL_INTENT_CONFLICT' });

    const resultHash = 'd'.repeat(64);
    store.loseNextAppendResponse = true;
    await expect(ledger.complete({ intent: value, resultHash })).resolves.toBeUndefined();
    await expect(ledger.accept(value)).resolves.toEqual({ state: 'completed', resultHash });
    await expect(ledger.complete({ intent: value, resultHash: 'e'.repeat(64) }))
      .rejects.toMatchObject({ code: 'CALL_INTENT_CONFLICT' });
  });

  it('eşzamanlı exact intent yarışında hiçbir çağrıyı tek creator diye işaretlemez', async () => {
    const store = new EventStoreFake();
    const ledger = new DurableExecutorIntent(store);
    const value = intent();
    const results = await Promise.all(Array.from({ length: 24 }, async () => await ledger.accept(value)));
    expect(results).toEqual(Array.from({ length: 24 }, () => ({ state: 'uncertain' })));
    expect(store.rows).toHaveLength(1);
  });

  it('mevcut completion state/request hash bozulmuşsa replayi fail-closed reddeder', async () => {
    const store = new EventStoreFake();
    const ledger = new DurableExecutorIntent(store);
    const value = intent();
    await ledger.accept(value);
    await ledger.complete({ intent: value, resultHash: 'd'.repeat(64) });
    const completion = [...store.rows.entries()].find(([, row]) => row.event_type === 'tool_result');
    expect(completion).toBeDefined();
    const [eventId, row] = completion!;
    store.rows.set(eventId, {
      ...row,
      payload: { ...(row.payload as Readonly<Record<string, string>>), requestHash: 'e'.repeat(64) },
    });
    await expect(ledger.accept(value)).rejects.toMatchObject({ code: 'CALL_INTENT_CONFLICT' });
  });

  it('gate ve commit auditinde raw projectKey saklamadan hash/count kanıtı yazar', async () => {
    const store = new EventStoreFake();
    const audit = new DurableGateCommitAudit(store);
    const operationId = id();
    const projectKey = '/private/workspace/sk-live-project-secret';
    await audit.appendGate({
      projectKey,
      operationId,
      occurredAt,
      step: {
        name: 'test', index: 0, passed: true, exitCode: 0, timedOut: false,
        truncated: false, durationMs: 4, stdoutBytes: 12, stderrBytes: 0,
        stdoutHash: 'a'.repeat(64), stderrHash: 'b'.repeat(64),
      },
    });
    await audit.appendCommit({
      kind: 'starter', projectKey, operationId: id(), occurredAt,
      commitHash: 'c'.repeat(40), reconciled: false,
      destinationHash: 'd'.repeat(64), requestHash: 'e'.repeat(64), targetFingerprint: 'f'.repeat(64),
    });
    expect(JSON.stringify([...store.rows.values()])).not.toContain(projectKey);
    expect([...store.rows.values()].map((row) => row.event_type).sort()).toEqual(['commit', 'test_run']);
  });
});
