import type { ClickHouseClient } from '@clickhouse/client';
import {
  AssignmentAttemptV1Schema,
  NIL_UUID,
  PromptInputSnapshotV1Schema,
  TaskBriefV1Schema,
  TaskHandoffV1Schema,
  canonicalJsonV1,
  canonicalSha256V1,
  type AssignmentAttemptV1,
  type PromptInputSnapshotV1,
  type TaskBriefV1,
  type TaskHandoffV1,
} from '@ww/shared';
import { concreteEntityId, storedUuid } from './identifiers.js';
import {
  RepositoryConflictError,
  RepositoryWriteError,
  StoredRecordError,
  readRowsAfterAcknowledgedWrite,
  readAfterUncertainWrite,
  storedDateTime,
  storedRecord,
  storedString,
  storedUInt64,
  storedUnsignedInteger,
  storedJsonValue,
  uncertainWriteError,
} from './types.js';

function mismatch(context: string, actual: unknown): never {
  throw new StoredRecordError(context, actual);
}

function safeUInt64Number(value: unknown, context: string): number {
  const parsed = BigInt(storedUInt64(value, context));
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) return mismatch(context, value);
  return Number(parsed);
}

function assertEqual(context: string, actual: unknown, expected: unknown): void {
  if (actual !== expected) mismatch(context, { actual, expected });
}

function parseCanonicalContract<T>(
  raw: unknown,
  context: string,
  schema: { parse(value: unknown): T },
): T {
  try {
    const text = storedString(raw, context);
    const contract = schema.parse(storedJsonValue(text, context));
    if (canonicalJsonV1(contract) !== text) mismatch(`${context}.canonical`, text);
    return contract;
  } catch (error) {
    if (error instanceof StoredRecordError) throw error;
    throw new StoredRecordError(context, error);
  }
}

function reconcileImmutable<T>(entity: string, expected: T, observed: readonly T[]): T {
  if (observed.length === 0) throw new RepositoryWriteError(`${entity} yazimi yeniden okunamadi`);
  const hash = canonicalSha256V1(expected);
  if (observed.some((value) => canonicalSha256V1(value) !== hash)) {
    throw new RepositoryConflictError(`${entity} immutable kimlik/hash catismasi`);
  }
  return observed[0]!;
}

const TASK_BRIEF_COLUMNS = `task_brief_id, contract_version, project_id, task_id,
  task_brief_version, task_version, plan_id, plan_version, plan_hash,
  context_snapshot_id, base_context_cutoff_at, sealed_at, contract_json,
  contract_hash`;

function parseTaskBriefRow(value: unknown): TaskBriefV1 {
  const row = storedRecord(value, 'task_briefs');
  const brief = parseCanonicalContract(row['contract_json'], 'task_briefs.contract_json', TaskBriefV1Schema);
  assertEqual('task_briefs.task_brief_id', storedUuid(row['task_brief_id'], 'task_briefs.task_brief_id'), brief.taskBriefId);
  assertEqual('task_briefs.contract_version', storedUnsignedInteger(row['contract_version'], 'task_briefs.contract_version', 65_535), brief.contractVersion);
  assertEqual('task_briefs.project_id', storedUuid(row['project_id'], 'task_briefs.project_id'), brief.projectId);
  assertEqual('task_briefs.task_id', storedUuid(row['task_id'], 'task_briefs.task_id'), brief.taskId);
  assertEqual('task_briefs.task_brief_version', storedUnsignedInteger(row['task_brief_version'], 'task_briefs.task_brief_version', 4_294_967_295), brief.taskBriefVersion);
  assertEqual('task_briefs.task_version', safeUInt64Number(row['task_version'], 'task_briefs.task_version'), brief.taskVersion);
  assertEqual('task_briefs.plan_id', storedUuid(row['plan_id'], 'task_briefs.plan_id'), brief.planId);
  assertEqual('task_briefs.plan_version', storedUnsignedInteger(row['plan_version'], 'task_briefs.plan_version', 4_294_967_295), brief.planVersion);
  assertEqual('task_briefs.plan_hash', storedString(row['plan_hash'], 'task_briefs.plan_hash'), brief.planHash);
  assertEqual('task_briefs.context_snapshot_id', storedUuid(row['context_snapshot_id'], 'task_briefs.context_snapshot_id'), brief.contextSnapshotId);
  assertEqual('task_briefs.base_context_cutoff_at', storedDateTime(row['base_context_cutoff_at'], 'task_briefs.base_context_cutoff_at'), storedDateTime(brief.baseContextCutoffAt, 'brief.baseContextCutoffAt'));
  assertEqual('task_briefs.sealed_at', storedDateTime(row['sealed_at'], 'task_briefs.sealed_at'), storedDateTime(brief.sealedAt, 'brief.sealedAt'));
  assertEqual('task_briefs.contract_hash', storedString(row['contract_hash'], 'task_briefs.contract_hash'), canonicalSha256V1(brief));
  return brief;
}

async function readTaskBriefRows(ch: ClickHouseClient, taskBriefId: string): Promise<TaskBriefV1[]> {
  const id = concreteEntityId(taskBriefId, 'taskBriefId');
  const result = await ch.query({
    query: `SELECT ${TASK_BRIEF_COLUMNS} FROM task_briefs
      WHERE task_brief_id = {taskBriefId:UUID}`,
    query_params: { taskBriefId: id },
    format: 'JSONEachRow',
  });
  return (await result.json<unknown>()).map(parseTaskBriefRow);
}

export async function getTaskBrief(ch: ClickHouseClient, taskBriefId: string): Promise<TaskBriefV1 | null> {
  const rows = await readTaskBriefRows(ch, taskBriefId);
  return rows.length === 0 ? null : reconcileImmutable(`taskBrief:${taskBriefId}`, rows[0]!, rows);
}

export async function appendTaskBrief(ch: ClickHouseClient, value: TaskBriefV1): Promise<TaskBriefV1> {
  const brief = TaskBriefV1Schema.parse(value);
  const prior = await readTaskBriefRows(ch, brief.taskBriefId);
  if (prior.length > 0) return reconcileImmutable(`taskBrief:${brief.taskBriefId}`, brief, prior);
  const contract_json = canonicalJsonV1(brief);
  const row = {
    task_brief_id: brief.taskBriefId,
    contract_version: brief.contractVersion,
    project_id: brief.projectId,
    task_id: brief.taskId,
    task_brief_version: brief.taskBriefVersion,
    task_version: brief.taskVersion,
    plan_id: brief.planId,
    plan_version: brief.planVersion,
    plan_hash: brief.planHash,
    context_snapshot_id: brief.contextSnapshotId,
    base_context_cutoff_at: brief.baseContextCutoffAt,
    sealed_at: brief.sealedAt,
    contract_json,
    contract_hash: canonicalSha256V1(brief),
  };
  try {
    await ch.insert({ table: 'task_briefs', values: [row], format: 'JSONEachRow' });
  } catch (error) {
    const entity = `taskBrief:${brief.taskBriefId}`;
    const observed = await readAfterUncertainWrite(
      entity,
      error,
      () => readTaskBriefRows(ch, brief.taskBriefId),
    );
    if (observed.length > 0) return reconcileImmutable(`taskBrief:${brief.taskBriefId}`, brief, observed);
    throw uncertainWriteError(entity, error);
  }
  const observed = await readRowsAfterAcknowledgedWrite(
    `taskBrief:${brief.taskBriefId}`,
    brief,
    () => readTaskBriefRows(ch, brief.taskBriefId),
  );
  return reconcileImmutable(`taskBrief:${brief.taskBriefId}`, brief, observed);
}

const ATTEMPT_COLUMNS = `assignment_attempt_id, contract_version, project_id,
  task_id, task_brief_id, attempt_number, worker_agent_id, verifier_agent_id,
  lease_owner, lease_fence, lease_expires_at, start_reason, previous_attempt_id,
  handoff_id, assigned_at, contract_json, contract_hash`;

function parseAssignmentAttemptRow(value: unknown): AssignmentAttemptV1 {
  const row = storedRecord(value, 'assignment_attempts');
  const attempt = parseCanonicalContract(row['contract_json'], 'assignment_attempts.contract_json', AssignmentAttemptV1Schema);
  assertEqual('assignment_attempts.assignment_attempt_id', storedUuid(row['assignment_attempt_id'], 'assignment_attempts.assignment_attempt_id'), attempt.assignmentAttemptId);
  assertEqual('assignment_attempts.contract_version', storedUnsignedInteger(row['contract_version'], 'assignment_attempts.contract_version', 65_535), attempt.contractVersion);
  assertEqual('assignment_attempts.project_id', storedUuid(row['project_id'], 'assignment_attempts.project_id'), attempt.projectId);
  assertEqual('assignment_attempts.task_id', storedUuid(row['task_id'], 'assignment_attempts.task_id'), attempt.taskId);
  assertEqual('assignment_attempts.task_brief_id', storedUuid(row['task_brief_id'], 'assignment_attempts.task_brief_id'), attempt.taskBriefId);
  assertEqual('assignment_attempts.attempt_number', storedUnsignedInteger(row['attempt_number'], 'assignment_attempts.attempt_number', 4_294_967_295), attempt.attemptNumber);
  assertEqual('assignment_attempts.worker_agent_id', storedUuid(row['worker_agent_id'], 'assignment_attempts.worker_agent_id'), attempt.workerAgentId);
  assertEqual('assignment_attempts.verifier_agent_id', storedUuid(row['verifier_agent_id'], 'assignment_attempts.verifier_agent_id'), attempt.verifierAgentId);
  assertEqual('assignment_attempts.lease_owner', storedString(row['lease_owner'], 'assignment_attempts.lease_owner'), attempt.leaseOwner);
  assertEqual('assignment_attempts.lease_fence', safeUInt64Number(row['lease_fence'], 'assignment_attempts.lease_fence'), attempt.leaseFence);
  assertEqual('assignment_attempts.lease_expires_at', storedDateTime(row['lease_expires_at'], 'assignment_attempts.lease_expires_at'), storedDateTime(attempt.leaseExpiresAt, 'attempt.leaseExpiresAt'));
  assertEqual('assignment_attempts.start_reason', storedString(row['start_reason'], 'assignment_attempts.start_reason'), attempt.startReason);
  assertEqual('assignment_attempts.previous_attempt_id', storedUuid(row['previous_attempt_id'], 'assignment_attempts.previous_attempt_id'), attempt.previousAttemptId ?? NIL_UUID);
  assertEqual('assignment_attempts.handoff_id', storedUuid(row['handoff_id'], 'assignment_attempts.handoff_id'), attempt.handoffId ?? NIL_UUID);
  assertEqual('assignment_attempts.assigned_at', storedDateTime(row['assigned_at'], 'assignment_attempts.assigned_at'), storedDateTime(attempt.assignedAt, 'attempt.assignedAt'));
  assertEqual('assignment_attempts.contract_hash', storedString(row['contract_hash'], 'assignment_attempts.contract_hash'), canonicalSha256V1(attempt));
  return attempt;
}

async function readAssignmentAttemptRows(ch: ClickHouseClient, assignmentAttemptId: string): Promise<AssignmentAttemptV1[]> {
  const id = concreteEntityId(assignmentAttemptId, 'assignmentAttemptId');
  const result = await ch.query({
    query: `SELECT ${ATTEMPT_COLUMNS} FROM assignment_attempts
      WHERE assignment_attempt_id = {assignmentAttemptId:UUID}`,
    query_params: { assignmentAttemptId: id },
    format: 'JSONEachRow',
  });
  return (await result.json<unknown>()).map(parseAssignmentAttemptRow);
}

export async function getAssignmentAttempt(ch: ClickHouseClient, assignmentAttemptId: string): Promise<AssignmentAttemptV1 | null> {
  const rows = await readAssignmentAttemptRows(ch, assignmentAttemptId);
  return rows.length === 0 ? null : reconcileImmutable(`assignmentAttempt:${assignmentAttemptId}`, rows[0]!, rows);
}

export async function appendAssignmentAttempt(ch: ClickHouseClient, value: AssignmentAttemptV1): Promise<AssignmentAttemptV1> {
  const attempt = AssignmentAttemptV1Schema.parse(value);
  const prior = await readAssignmentAttemptRows(ch, attempt.assignmentAttemptId);
  if (prior.length > 0) return reconcileImmutable(`assignmentAttempt:${attempt.assignmentAttemptId}`, attempt, prior);
  const row = {
    assignment_attempt_id: attempt.assignmentAttemptId,
    contract_version: attempt.contractVersion,
    project_id: attempt.projectId,
    task_id: attempt.taskId,
    task_brief_id: attempt.taskBriefId,
    attempt_number: attempt.attemptNumber,
    worker_agent_id: attempt.workerAgentId,
    verifier_agent_id: attempt.verifierAgentId,
    lease_owner: attempt.leaseOwner,
    lease_fence: attempt.leaseFence,
    lease_expires_at: attempt.leaseExpiresAt,
    start_reason: attempt.startReason,
    previous_attempt_id: attempt.previousAttemptId ?? NIL_UUID,
    handoff_id: attempt.handoffId ?? NIL_UUID,
    assigned_at: attempt.assignedAt,
    contract_json: canonicalJsonV1(attempt),
    contract_hash: canonicalSha256V1(attempt),
  };
  try {
    await ch.insert({ table: 'assignment_attempts', values: [row], format: 'JSONEachRow' });
  } catch (error) {
    const entity = `assignmentAttempt:${attempt.assignmentAttemptId}`;
    const observed = await readAfterUncertainWrite(
      entity,
      error,
      () => readAssignmentAttemptRows(ch, attempt.assignmentAttemptId),
    );
    if (observed.length > 0) return reconcileImmutable(`assignmentAttempt:${attempt.assignmentAttemptId}`, attempt, observed);
    throw uncertainWriteError(entity, error);
  }
  const observed = await readRowsAfterAcknowledgedWrite(
    `assignmentAttempt:${attempt.assignmentAttemptId}`,
    attempt,
    () => readAssignmentAttemptRows(ch, attempt.assignmentAttemptId),
  );
  return reconcileImmutable(`assignmentAttempt:${attempt.assignmentAttemptId}`, attempt, observed);
}

const SNAPSHOT_COLUMNS = `prompt_input_snapshot_id, contract_version,
  invocation_id, project_id, task_id, task_brief_id, assignment_attempt_id,
  input_causal_ordinal, input_causal_handoff_id, source_version_manifest_json,
  prompt_messages_json, prompt_hash, sealed_at, contract_json, contract_hash`;

function parsePromptInputSnapshotRow(value: unknown): PromptInputSnapshotV1 {
  const row = storedRecord(value, 'prompt_input_snapshots');
  const snapshot = parseCanonicalContract(row['contract_json'], 'prompt_input_snapshots.contract_json', PromptInputSnapshotV1Schema);
  assertEqual('prompt_input_snapshots.prompt_input_snapshot_id', storedUuid(row['prompt_input_snapshot_id'], 'prompt_input_snapshots.prompt_input_snapshot_id'), snapshot.promptInputSnapshotId);
  assertEqual('prompt_input_snapshots.contract_version', storedUnsignedInteger(row['contract_version'], 'prompt_input_snapshots.contract_version', 65_535), snapshot.contractVersion);
  assertEqual('prompt_input_snapshots.invocation_id', storedUuid(row['invocation_id'], 'prompt_input_snapshots.invocation_id'), snapshot.invocationId);
  assertEqual('prompt_input_snapshots.project_id', storedUuid(row['project_id'], 'prompt_input_snapshots.project_id'), snapshot.projectId);
  assertEqual('prompt_input_snapshots.task_id', storedUuid(row['task_id'], 'prompt_input_snapshots.task_id'), snapshot.taskId);
  assertEqual('prompt_input_snapshots.task_brief_id', storedUuid(row['task_brief_id'], 'prompt_input_snapshots.task_brief_id'), snapshot.taskBriefId);
  assertEqual('prompt_input_snapshots.assignment_attempt_id', storedUuid(row['assignment_attempt_id'], 'prompt_input_snapshots.assignment_attempt_id'), snapshot.assignmentAttemptId);
  assertEqual('prompt_input_snapshots.input_causal_ordinal', safeUInt64Number(row['input_causal_ordinal'], 'prompt_input_snapshots.input_causal_ordinal'), snapshot.inputTaskCausalCursor.ordinal);
  assertEqual('prompt_input_snapshots.input_causal_handoff_id', storedUuid(row['input_causal_handoff_id'], 'prompt_input_snapshots.input_causal_handoff_id'), snapshot.inputTaskCausalCursor.handoffId ?? NIL_UUID);
  assertEqual('prompt_input_snapshots.source_version_manifest_json', storedString(row['source_version_manifest_json'], 'prompt_input_snapshots.source_version_manifest_json'), canonicalJsonV1(snapshot.sourceVersionManifest));
  assertEqual('prompt_input_snapshots.prompt_messages_json', storedString(row['prompt_messages_json'], 'prompt_input_snapshots.prompt_messages_json'), canonicalJsonV1(snapshot.promptMessages));
  assertEqual('prompt_input_snapshots.prompt_hash', storedString(row['prompt_hash'], 'prompt_input_snapshots.prompt_hash'), snapshot.promptHash);
  assertEqual('prompt_input_snapshots.sealed_at', storedDateTime(row['sealed_at'], 'prompt_input_snapshots.sealed_at'), storedDateTime(snapshot.sealedAt, 'snapshot.sealedAt'));
  assertEqual('prompt_input_snapshots.contract_hash', storedString(row['contract_hash'], 'prompt_input_snapshots.contract_hash'), canonicalSha256V1(snapshot));
  return snapshot;
}

async function readPromptInputSnapshotRows(ch: ClickHouseClient, promptInputSnapshotId: string): Promise<PromptInputSnapshotV1[]> {
  const id = concreteEntityId(promptInputSnapshotId, 'promptInputSnapshotId');
  const result = await ch.query({
    query: `SELECT ${SNAPSHOT_COLUMNS} FROM prompt_input_snapshots
      WHERE prompt_input_snapshot_id = {promptInputSnapshotId:UUID}`,
    query_params: { promptInputSnapshotId: id },
    format: 'JSONEachRow',
  });
  return (await result.json<unknown>()).map(parsePromptInputSnapshotRow);
}

export async function getPromptInputSnapshot(ch: ClickHouseClient, promptInputSnapshotId: string): Promise<PromptInputSnapshotV1 | null> {
  const rows = await readPromptInputSnapshotRows(ch, promptInputSnapshotId);
  return rows.length === 0 ? null : reconcileImmutable(`promptInputSnapshot:${promptInputSnapshotId}`, rows[0]!, rows);
}

export async function appendPromptInputSnapshot(ch: ClickHouseClient, value: PromptInputSnapshotV1): Promise<PromptInputSnapshotV1> {
  const snapshot = PromptInputSnapshotV1Schema.parse(value);
  const prior = await readPromptInputSnapshotRows(ch, snapshot.promptInputSnapshotId);
  if (prior.length > 0) return reconcileImmutable(`promptInputSnapshot:${snapshot.promptInputSnapshotId}`, snapshot, prior);
  const row = {
    prompt_input_snapshot_id: snapshot.promptInputSnapshotId,
    contract_version: snapshot.contractVersion,
    invocation_id: snapshot.invocationId,
    project_id: snapshot.projectId,
    task_id: snapshot.taskId,
    task_brief_id: snapshot.taskBriefId,
    assignment_attempt_id: snapshot.assignmentAttemptId,
    input_causal_ordinal: snapshot.inputTaskCausalCursor.ordinal,
    input_causal_handoff_id: snapshot.inputTaskCausalCursor.handoffId ?? NIL_UUID,
    source_version_manifest_json: canonicalJsonV1(snapshot.sourceVersionManifest),
    prompt_messages_json: canonicalJsonV1(snapshot.promptMessages),
    prompt_hash: snapshot.promptHash,
    sealed_at: snapshot.sealedAt,
    contract_json: canonicalJsonV1(snapshot),
    contract_hash: canonicalSha256V1(snapshot),
  };
  try {
    await ch.insert({ table: 'prompt_input_snapshots', values: [row], format: 'JSONEachRow' });
  } catch (error) {
    const entity = `promptInputSnapshot:${snapshot.promptInputSnapshotId}`;
    const observed = await readAfterUncertainWrite(
      entity,
      error,
      () => readPromptInputSnapshotRows(ch, snapshot.promptInputSnapshotId),
    );
    if (observed.length > 0) return reconcileImmutable(`promptInputSnapshot:${snapshot.promptInputSnapshotId}`, snapshot, observed);
    throw uncertainWriteError(entity, error);
  }
  const observed = await readRowsAfterAcknowledgedWrite(
    `promptInputSnapshot:${snapshot.promptInputSnapshotId}`,
    snapshot,
    () => readPromptInputSnapshotRows(ch, snapshot.promptInputSnapshotId),
  );
  return reconcileImmutable(`promptInputSnapshot:${snapshot.promptInputSnapshotId}`, snapshot, observed);
}

const HANDOFF_COLUMNS = `handoff_id, contract_version, project_id, task_id,
  task_brief_id, from_assignment_attempt_id, to_assignment_attempt_id,
  ancestor_ordinal, ancestor_handoff_id, created_at, contract_json, contract_hash`;

function parseTaskHandoffRow(value: unknown): TaskHandoffV1 {
  const row = storedRecord(value, 'task_handoffs');
  const handoff = parseCanonicalContract(row['contract_json'], 'task_handoffs.contract_json', TaskHandoffV1Schema);
  assertEqual('task_handoffs.handoff_id', storedUuid(row['handoff_id'], 'task_handoffs.handoff_id'), handoff.handoffId);
  assertEqual('task_handoffs.contract_version', storedUnsignedInteger(row['contract_version'], 'task_handoffs.contract_version', 65_535), handoff.contractVersion);
  assertEqual('task_handoffs.project_id', storedUuid(row['project_id'], 'task_handoffs.project_id'), handoff.projectId);
  assertEqual('task_handoffs.task_id', storedUuid(row['task_id'], 'task_handoffs.task_id'), handoff.taskId);
  assertEqual('task_handoffs.task_brief_id', storedUuid(row['task_brief_id'], 'task_handoffs.task_brief_id'), handoff.taskBriefId);
  assertEqual('task_handoffs.from_assignment_attempt_id', storedUuid(row['from_assignment_attempt_id'], 'task_handoffs.from_assignment_attempt_id'), handoff.fromAssignmentAttemptId);
  assertEqual('task_handoffs.to_assignment_attempt_id', storedUuid(row['to_assignment_attempt_id'], 'task_handoffs.to_assignment_attempt_id'), handoff.toAssignmentAttemptId);
  assertEqual('task_handoffs.ancestor_ordinal', safeUInt64Number(row['ancestor_ordinal'], 'task_handoffs.ancestor_ordinal'), handoff.ancestorCursor.ordinal);
  assertEqual('task_handoffs.ancestor_handoff_id', storedUuid(row['ancestor_handoff_id'], 'task_handoffs.ancestor_handoff_id'), handoff.ancestorCursor.handoffId ?? NIL_UUID);
  assertEqual('task_handoffs.created_at', storedDateTime(row['created_at'], 'task_handoffs.created_at'), storedDateTime(handoff.createdAt, 'handoff.createdAt'));
  assertEqual('task_handoffs.contract_hash', storedString(row['contract_hash'], 'task_handoffs.contract_hash'), canonicalSha256V1(handoff));
  return handoff;
}

async function readTaskHandoffRows(ch: ClickHouseClient, handoffId: string): Promise<TaskHandoffV1[]> {
  const id = concreteEntityId(handoffId, 'handoffId');
  const result = await ch.query({
    query: `SELECT ${HANDOFF_COLUMNS} FROM task_handoffs WHERE handoff_id = {handoffId:UUID}`,
    query_params: { handoffId: id },
    format: 'JSONEachRow',
  });
  return (await result.json<unknown>()).map(parseTaskHandoffRow);
}

export async function getTaskHandoff(ch: ClickHouseClient, handoffId: string): Promise<TaskHandoffV1 | null> {
  const rows = await readTaskHandoffRows(ch, handoffId);
  return rows.length === 0 ? null : reconcileImmutable(`taskHandoff:${handoffId}`, rows[0]!, rows);
}

export async function appendTaskHandoff(ch: ClickHouseClient, value: TaskHandoffV1): Promise<TaskHandoffV1> {
  const handoff = TaskHandoffV1Schema.parse(value);
  const prior = await readTaskHandoffRows(ch, handoff.handoffId);
  if (prior.length > 0) return reconcileImmutable(`taskHandoff:${handoff.handoffId}`, handoff, prior);
  const row = {
    handoff_id: handoff.handoffId,
    contract_version: handoff.contractVersion,
    project_id: handoff.projectId,
    task_id: handoff.taskId,
    task_brief_id: handoff.taskBriefId,
    from_assignment_attempt_id: handoff.fromAssignmentAttemptId,
    to_assignment_attempt_id: handoff.toAssignmentAttemptId,
    ancestor_ordinal: handoff.ancestorCursor.ordinal,
    ancestor_handoff_id: handoff.ancestorCursor.handoffId ?? NIL_UUID,
    created_at: handoff.createdAt,
    contract_json: canonicalJsonV1(handoff),
    contract_hash: canonicalSha256V1(handoff),
  };
  try {
    await ch.insert({ table: 'task_handoffs', values: [row], format: 'JSONEachRow' });
  } catch (error) {
    const entity = `taskHandoff:${handoff.handoffId}`;
    const observed = await readAfterUncertainWrite(
      entity,
      error,
      () => readTaskHandoffRows(ch, handoff.handoffId),
    );
    if (observed.length > 0) return reconcileImmutable(`taskHandoff:${handoff.handoffId}`, handoff, observed);
    throw uncertainWriteError(entity, error);
  }
  const observed = await readRowsAfterAcknowledgedWrite(
    `taskHandoff:${handoff.handoffId}`,
    handoff,
    () => readTaskHandoffRows(ch, handoff.handoffId),
  );
  return reconcileImmutable(`taskHandoff:${handoff.handoffId}`, handoff, observed);
}
