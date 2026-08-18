import type { ClickHouseClient } from '@clickhouse/client';
import { type EntityId } from '@ww/shared';
import {
  concreteEntityId,
  optionalEntityId,
  storedUuid,
  type StoredOptionalEntityId,
} from './identifiers.js';
import {
  RepositoryConflictError,
  StoredRecordError,
  storedEnum,
  storedRecord,
  storedString,
  storedUnsignedInteger,
} from './types.js';

const SUCCESS_USAGE_STATUSES = ['ok', 'fallback_used'] as const;
const MAX_INVOCATION_USAGE_CANDIDATES = 100;

export interface ActualModelInvocationScope {
  readonly projectId: string;
  readonly agentId: string;
  readonly taskId: string;
  readonly taskBriefId: string;
  readonly assignmentAttemptId: string;
  readonly promptInputSnapshotId: string;
}

export interface ActualModelRefRecord {
  readonly invocationId: EntityId;
  readonly usedRef: string;
  readonly fallbackAttempt: number;
  readonly projectId: EntityId;
  readonly agentId: EntityId;
  readonly taskId: StoredOptionalEntityId;
  readonly taskBriefId: StoredOptionalEntityId;
  readonly assignmentAttemptId: StoredOptionalEntityId;
  readonly promptInputSnapshotId: StoredOptionalEntityId;
  readonly usageIds: readonly EntityId[];
}

interface SuccessfulUsageCandidate extends Omit<ActualModelRefRecord, 'usageIds'> {
  readonly usageId: EntityId;
  readonly purpose: string;
}

function nonempty(value: unknown, context: string): string {
  const parsed = storedString(value, context).trim();
  if (parsed.length === 0) throw new StoredRecordError(context, value);
  return parsed;
}

function parseCandidate(value: unknown): SuccessfulUsageCandidate {
  const row = storedRecord(value, 'api_usage actual model candidate');
  const providerId = nonempty(row['provider_id'], 'api_usage.provider_id');
  if (providerId.includes(':')) throw new StoredRecordError('api_usage.provider_id', providerId);
  const model = nonempty(row['model'], 'api_usage.model');
  storedEnum(row['status'], SUCCESS_USAGE_STATUSES, 'api_usage.status');
  return Object.freeze({
    invocationId: concreteEntityId(
      storedUuid(row['invocation_id'], 'api_usage.invocation_id'),
      'api_usage.invocation_id',
    ),
    usedRef: `${providerId}:${model}`,
    fallbackAttempt: storedUnsignedInteger(
      row['fallback_attempt'],
      'api_usage.fallback_attempt',
      4_294_967_295,
    ),
    projectId: concreteEntityId(
      storedUuid(row['project_id'], 'api_usage.project_id'),
      'api_usage.project_id',
    ),
    agentId: concreteEntityId(
      storedUuid(row['agent_id'], 'api_usage.agent_id'),
      'api_usage.agent_id',
    ),
    taskId: optionalEntityId(
      storedUuid(row['task_id'], 'api_usage.task_id'),
      'api_usage.task_id',
    ),
    taskBriefId: optionalEntityId(
      storedUuid(row['task_brief_id'], 'api_usage.task_brief_id'),
      'api_usage.task_brief_id',
    ),
    assignmentAttemptId: optionalEntityId(
      storedUuid(row['assignment_attempt_id'], 'api_usage.assignment_attempt_id'),
      'api_usage.assignment_attempt_id',
    ),
    promptInputSnapshotId: optionalEntityId(
      storedUuid(row['prompt_input_snapshot_id'], 'api_usage.prompt_input_snapshot_id'),
      'api_usage.prompt_input_snapshot_id',
    ),
    usageId: concreteEntityId(
      storedUuid(row['usage_id'], 'api_usage.usage_id'),
      'api_usage.usage_id',
    ),
    purpose: nonempty(row['purpose'], 'api_usage.purpose'),
  });
}

function normalizeExpectedScope(expected: ActualModelInvocationScope): Omit<
  ActualModelRefRecord,
  'invocationId' | 'usedRef' | 'fallbackAttempt' | 'usageIds'
> {
  return Object.freeze({
    projectId: concreteEntityId(expected.projectId, 'expected.projectId'),
    agentId: concreteEntityId(expected.agentId, 'expected.agentId'),
    taskId: concreteEntityId(expected.taskId, 'expected.taskId'),
    taskBriefId: concreteEntityId(expected.taskBriefId, 'expected.taskBriefId'),
    assignmentAttemptId: concreteEntityId(
      expected.assignmentAttemptId,
      'expected.assignmentAttemptId',
    ),
    promptInputSnapshotId: concreteEntityId(
      expected.promptInputSnapshotId,
      'expected.promptInputSnapshotId',
    ),
  });
}

function sameCandidate(left: SuccessfulUsageCandidate, right: SuccessfulUsageCandidate): boolean {
  return left.invocationId === right.invocationId &&
    left.usedRef === right.usedRef &&
    left.fallbackAttempt === right.fallbackAttempt &&
    left.projectId === right.projectId &&
    left.agentId === right.agentId &&
    left.taskId === right.taskId &&
    left.taskBriefId === right.taskBriefId &&
    left.assignmentAttemptId === right.assignmentAttemptId &&
    left.promptInputSnapshotId === right.promptInputSnapshotId;
}

/**
 * Returns the successful highest fallback attempt for one completion invocation.
 * Duplicate identical usage rows reconcile; any non-completion purpose, model,
 * or provenance ambiguity fails closed.
 */
export async function getActualModelRefForInvocation(
  ch: ClickHouseClient,
  invocationId: string,
  expected?: ActualModelInvocationScope,
): Promise<ActualModelRefRecord | null> {
  const invocation = concreteEntityId(invocationId, 'invocationId');
  const result = await ch.query({
    query: `SELECT usage_id, project_id, agent_id, task_id, provider_id, model,
        purpose, status, invocation_id, task_brief_id, assignment_attempt_id,
        prompt_input_snapshot_id, fallback_attempt
      FROM invocation_api_usage
      PREWHERE invocation_id = {invocationId:UUID}
      WHERE status IN ('ok', 'fallback_used')
        AND
        (
          purpose != 'completion'
          OR fallback_attempt =
          (
            SELECT max(fallback_attempt) FROM invocation_api_usage
            PREWHERE invocation_id = {invocationId:UUID}
            WHERE status IN ('ok', 'fallback_used')
          )
        )
      ORDER BY usage_id
      LIMIT {candidateLimit:UInt32}`,
    query_params: {
      invocationId: invocation,
      candidateLimit: MAX_INVOCATION_USAGE_CANDIDATES + 1,
    },
    format: 'JSONEachRow',
  });
  const candidates = (await result.json<unknown>()).map(parseCandidate);
  if (candidates.length === 0) return null;
  if (candidates.length > MAX_INVOCATION_USAGE_CANDIDATES) {
    throw new RepositoryConflictError(`api_usage invocation aday sinirini asti: ${invocation}`);
  }
  if (candidates.some((candidate) => candidate.purpose !== 'completion')) {
    throw new RepositoryConflictError(`api_usage invocation purpose catismasi: ${invocation}`);
  }
  const winner = candidates[0]!;
  if (candidates.some((candidate) => !sameCandidate(winner, candidate))) {
    throw new RepositoryConflictError(`api_usage invocation provenance catismasi: ${invocation}`);
  }
  const scope = expected === undefined ? undefined : normalizeExpectedScope(expected);
  if (
    scope !== undefined &&
    (
      winner.projectId !== scope.projectId ||
      winner.agentId !== scope.agentId ||
      winner.taskId !== scope.taskId ||
      winner.taskBriefId !== scope.taskBriefId ||
      winner.assignmentAttemptId !== scope.assignmentAttemptId ||
      winner.promptInputSnapshotId !== scope.promptInputSnapshotId
    )
  ) {
    throw new RepositoryConflictError(`api_usage invocation scope catismasi: ${invocation}`);
  }
  return Object.freeze({
    invocationId: winner.invocationId,
    usedRef: winner.usedRef,
    fallbackAttempt: winner.fallbackAttempt,
    projectId: winner.projectId,
    agentId: winner.agentId,
    taskId: winner.taskId,
    taskBriefId: winner.taskBriefId,
    assignmentAttemptId: winner.assignmentAttemptId,
    promptInputSnapshotId: winner.promptInputSnapshotId,
    usageIds: Object.freeze(candidates.map((candidate) => candidate.usageId).sort()),
  });
}

/**
 * Bir görevin GERÇEK token harcaması (docs/07 "görev token tavanı").
 *
 * NEDEN BURADA: `tasks.tokens_spent` kolonu üretimde yalnızca 0 olarak
 * yazılıyor — görev açılışı dışında hiçbir yazıcısı yok. Fren o kolonu
 * okuduğu sürece hiçbir zaman atamaz. Tek gerçek kaynak `api_usage`'dır;
 * hemen yanındaki maliyet freni de zaten oradan okur.
 *
 * Yalnız GÖREVİN KENDİ çağrıları sayılır: alt görevlerin kendi tavanı vardır.
 * Başarısız çağrılar da sayılır — token yakıldıysa yakılmıştır.
 */
export async function sumTaskTokensSpent(
  ch: ClickHouseClient,
  taskId: string,
): Promise<number> {
  const result = await ch.query({
    query: `SELECT sum(prompt_tokens + completion_tokens) AS tokens
      FROM api_usage WHERE task_id = {taskId:UUID}`,
    query_params: { taskId },
    format: 'JSONEachRow',
  });
  const rows = await result.json<Record<string, unknown>>();
  const value = Number(rows[0]?.['tokens'] ?? 0);
  // Bilinmeyen görev ya da hiç çağrı: 0. Fren atmaz, sistem durmaz.
  return Number.isFinite(value) ? value : 0;
}
