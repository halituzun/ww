import { toStrictJsonPayload } from './strict-json-payload.js';
import {
  appendEvent,
  getEvent,
  type AppendEventInput,
  type ClickHouseClient,
  type EventRow,
} from '@ww/db';
import {
  EntityIdSchema,
  JsonValueSchema,
  NIL_UUID,
  canonicalSha256V1,
  type EntityId,
} from '@ww/shared';
import { ExecutorError } from './errors.js';
import type {
  CommitAuditInput,
  ExecutorAuditEvent,
  ExecutorAuditPort,
  ExecutorIntentAcceptance,
  ExecutorIntentPort,
  ExecutorToolIntent,
  GateAuditInput,
  GateCommitAuditPort,
} from './ports.js';

// Concrete repository identity for infrastructure-only gate audit rows.
// NIL_UUID and SYSTEM_SENTINEL are intentionally rejected by EntityIdSchema.
const EXECUTOR_AUDIT_ENTITY_ID = '00000000-0000-4000-8000-000000000001' as EntityId;

export interface ExecutorEventStorePort {
  get(eventId: EntityId): Promise<EventRow | null>;
  append(event: AppendEventInput): Promise<EventRow>;
}

export function clickHouseExecutorEventStore(ch: ClickHouseClient): ExecutorEventStorePort {
  return Object.freeze({
    get: async (eventId: EntityId) => await getEvent(ch, eventId),
    append: async (event: AppendEventInput) => await appendEvent(ch, event),
  });
}

function eventId(namespace: string, value: unknown): EntityId {
  const hex = canonicalSha256V1({ namespace, value });
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return EntityIdSchema.parse(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`,
  );
}

function exact(expected: AppendEventInput, observed: EventRow, conflictCode: 'AUDIT_FAILED' | 'CALL_INTENT_CONFLICT'): EventRow {
  if (canonicalSha256V1(expected) !== canonicalSha256V1(observed)) {
    throw new ExecutorError(conflictCode, 'Kalıcı executor olayı immutable içerikle çakıştı');
  }
  return observed;
}

async function ensureEvent(
  store: ExecutorEventStorePort,
  expected: AppendEventInput,
  conflictCode: 'AUDIT_FAILED' | 'CALL_INTENT_CONFLICT',
): Promise<Readonly<{ row: EventRow; disposition: 'existing' | 'ambiguous' }>> {
  try {
    const prior = await store.get(expected.event_id);
    if (prior !== null) {
      return Object.freeze({ row: exact(expected, prior, conflictCode), disposition: 'existing' });
    }
    try {
      return Object.freeze({
        row: exact(expected, await store.append(expected), conflictCode),
        disposition: 'ambiguous',
      });
    } catch {
      const reconciled = await store.get(expected.event_id);
      if (reconciled !== null) {
        return Object.freeze({ row: exact(expected, reconciled, conflictCode), disposition: 'ambiguous' });
      }
      throw new ExecutorError('AUDIT_FAILED', 'Kalıcı executor olayı yazılamadı');
    }
  } catch (error) {
    if (error instanceof ExecutorError) throw error;
    throw new ExecutorError('AUDIT_FAILED', 'Kalıcı executor olayı uzlaştırılamadı');
  }
}

function sequence(occurredAt: string): string {
  const value = Date.parse(occurredAt);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ExecutorError('INVALID_ARGUMENTS', 'Audit occurredAt canonical tarih olmalıdır');
  }
  return String(value);
}

function baseEvent(input: Readonly<{
  eventId: EntityId;
  projectId: EntityId;
  taskId: EntityId;
  agentId: EntityId;
  eventType: AppendEventInput['event_type'];
  toolName: string;
  payload: unknown;
  durationMs: number;
  occurredAt: string;
}>): AppendEventInput {
  return Object.freeze({
    event_id: input.eventId,
    seq: sequence(input.occurredAt),
    project_id: input.projectId,
    task_id: input.taskId,
    agent_id: input.agentId,
    event_type: input.eventType,
    tool_name: input.toolName,
    // JSON'da undefined yoktur; araç sonucundaki tek tanımsız alan tüm
    // denetim kaydını (ve dolayısıyla görevi) düşürüyordu.
    payload: JsonValueSchema.parse(toStrictJsonPayload(input.payload)),
    duration_ms: input.durationMs,
    created_at: input.occurredAt,
  });
}

export class DurableExecutorAudit implements ExecutorAuditPort {
  constructor(readonly store: ExecutorEventStorePort) {}

  async append(input: ExecutorAuditEvent): Promise<void> {
    const safeToolName = /^[a-z_]{1,64}$/.test(input.toolName) ? input.toolName : '<invalid>';
    await ensureEvent(this.store, baseEvent({
      eventId: input.eventId,
      projectId: input.projectId,
      taskId: input.taskId,
      agentId: input.agentId,
      eventType: input.eventType,
      toolName: 'executor',
      payload: {
        contractVersion: 1,
        assignmentAttemptId: input.assignmentAttemptId,
        toolCallId: input.toolCallId,
        toolName: safeToolName,
        toolNameHash: canonicalSha256V1({ toolName: input.toolName }),
        payload: input.payload,
      },
      durationMs: 0,
      occurredAt: input.occurredAt,
    }), 'AUDIT_FAILED');
  }
}

function intentEvent(intent: ExecutorToolIntent): AppendEventInput {
  return baseEvent({
    eventId: eventId('executor.tool-intent.v1', { callId: intent.callId }),
    projectId: intent.projectId,
    taskId: intent.taskId,
    agentId: intent.agentId,
    eventType: 'tool_call',
    toolName: 'executor_intent',
    payload: { contractVersion: 1, ...intent },
    durationMs: 0,
    occurredAt: intent.occurredAt,
  });
}

function completionEvent(intent: ExecutorToolIntent, resultHash: string): AppendEventInput {
  return baseEvent({
    eventId: eventId('executor.tool-completion.v1', { callId: intent.callId }),
    projectId: intent.projectId,
    taskId: intent.taskId,
    agentId: intent.agentId,
    eventType: 'tool_result',
    toolName: 'executor_intent',
    payload: {
      contractVersion: 1,
      callId: intent.callId,
      requestHash: intent.requestHash,
      resultHash,
    },
    durationMs: 0,
    occurredAt: intent.occurredAt,
  });
}

export class DurableExecutorIntent implements ExecutorIntentPort {
  constructor(readonly store: ExecutorEventStorePort) {}

  async accept(intent: ExecutorToolIntent): Promise<ExecutorIntentAcceptance> {
    const acceptance = await ensureEvent(this.store, intentEvent(intent), 'CALL_INTENT_CONFLICT');
    const completionId = eventId('executor.tool-completion.v1', { callId: intent.callId });
    let completed: EventRow | null;
    try {
      completed = await this.store.get(completionId);
    } catch {
      throw new ExecutorError('AUDIT_FAILED', 'Kalıcı tool completion okunamadı');
    }
    if (completed === null) {
      // A plain ClickHouse MergeTree insert has no unique-create primitive. Even
      // an acknowledged append may have raced an exact writer, and a recovered
      // response-loss is equally ambiguous. Only an event observed before our
      // append is a known replay; ambiguous creation must not enable edit recovery.
      return Object.freeze({
        state: acceptance.disposition === 'existing' ? 'replay' : 'uncertain',
      });
    }
    const payload = completed.payload;
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload) ||
      typeof (payload as Readonly<Record<string, unknown>>)['resultHash'] !== 'string') {
      throw new ExecutorError('CALL_INTENT_CONFLICT', 'Kalıcı tool completion sonucu geçersiz');
    }
    const resultHash = (payload as Readonly<Record<string, string>>)['resultHash']!;
    exact(completionEvent(intent, resultHash), completed, 'CALL_INTENT_CONFLICT');
    return Object.freeze({ state: 'completed', resultHash });
  }

  async complete(input: Readonly<{ intent: ExecutorToolIntent; resultHash: string }>): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(input.resultHash)) {
      throw new ExecutorError('INVALID_ARGUMENTS', 'Tool result hash geçersiz');
    }
    await ensureEvent(
      this.store,
      completionEvent(input.intent, input.resultHash),
      'CALL_INTENT_CONFLICT',
    );
  }
}

export class DurableGateCommitAudit implements GateCommitAuditPort {
  constructor(readonly store: ExecutorEventStorePort) {}

  async appendGate(input: GateAuditInput): Promise<void> {
    await ensureEvent(this.store, baseEvent({
      eventId: eventId('executor.gate.v1', {
        operationId: input.operationId,
        index: input.step.index,
        name: input.step.name,
      }),
      // Gate audits are infrastructure events and have no task principal.
      // NIL_UUID is a valid optional-storage sentinel, but not a concrete
      // EntityId; use the stable system sentinel so repository parsing remains
      // strict while retaining the projectKey hash in the payload.
      projectId: EXECUTOR_AUDIT_ENTITY_ID,
      taskId: EXECUTOR_AUDIT_ENTITY_ID,
      agentId: EXECUTOR_AUDIT_ENTITY_ID,
      eventType: 'test_run',
      toolName: 'executor_gate',
      payload: {
        contractVersion: 1,
        projectKeyHash: canonicalSha256V1({ projectKey: input.projectKey }),
        operationId: input.operationId,
        step: input.step,
      },
      // Sandbox timings may be fractional (performance.now); DB duration_ms
      // is an unsigned integer contract.
      durationMs: Math.max(0, Math.round(input.step.durationMs)),
      occurredAt: input.occurredAt,
    }), 'AUDIT_FAILED');
  }

  async appendCommit(input: CommitAuditInput): Promise<void> {
    const safe: Record<string, unknown> = { ...input };
    delete safe['projectKey'];
    await ensureEvent(this.store, baseEvent({
      eventId: eventId('executor.commit.v1', { operationId: input.operationId }),
      projectId: input.kind === 'task' ? input.projectId : NIL_UUID,
      taskId: input.kind === 'task' ? input.taskId : NIL_UUID,
      agentId: input.kind === 'task' ? input.agentId : NIL_UUID,
      eventType: 'commit',
      toolName: 'executor_git',
      payload: {
        contractVersion: 1,
        projectKeyHash: canonicalSha256V1({ projectKey: input.projectKey }),
        ...safe,
      },
      durationMs: 0,
      occurredAt: input.occurredAt,
    }), 'AUDIT_FAILED');
  }
}
