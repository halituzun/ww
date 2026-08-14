import type { ClickHouseClient } from '@clickhouse/client';
import {
  PLAN_STATUSES,
  canonicalSha256V1,
  type EntityId,
  type JsonValue,
  type PlanStatus,
} from '@ww/shared';
import {
  concreteEntityId,
  optionalEntityId,
  storedUuid,
  type StoredOptionalEntityId,
} from './identifiers.js';
import {
  RepositoryConflictError,
  RepositoryNotFoundError,
  StoredRecordError,
  assertExpectedVersion,
  nextRepositoryVersion,
  readRowsAfterAcknowledgedWrite,
  readAfterUncertainWrite,
  reconcileVersionedWrite,
  serializeJsonValue,
  storedDateTime,
  storedEnum,
  storedJsonValue,
  storedRecord,
  storedString,
  storedUInt64,
  storedUnsignedInteger,
  uncertainWriteError,
  type UInt64String,
} from './types.js';

export interface PlanRow {
  readonly plan_id: EntityId;
  readonly project_id: EntityId;
  readonly plan_version: number;
  readonly status: PlanStatus;
  readonly title: string;
  readonly content_md: string;
  readonly council_session_id: StoredOptionalEntityId;
  readonly team_json: JsonValue;
  readonly scenarios_json: JsonValue;
  readonly replan_reason: string;
  readonly supersedes_plan_id: StoredOptionalEntityId;
  readonly created_by_agent_id: EntityId;
  readonly approved_by: string;
  readonly created_at: string;
  readonly version: UInt64String;
}

export type CreatePlanInput = Omit<PlanRow, 'version'>;

export interface AppendPlanVersionInput {
  readonly expectedVersion: UInt64String;
  readonly next: Omit<PlanRow, 'version'>;
}

const PLAN_COLUMNS = `plan_id, project_id, plan_version, status, title, content_md,
  council_session_id, team_json, scenarios_json, replan_reason,
  supersedes_plan_id, created_by_agent_id, approved_by, created_at, version,
  row_hash`;
const ROW_HASH = /^[0-9a-f]{64}$/;

function planRowHash(row: PlanRow): string {
  return canonicalSha256V1([
    row.plan_id,
    row.project_id,
    row.plan_version,
    row.status,
    row.title,
    row.content_md,
    row.council_session_id,
    row.team_json,
    row.scenarios_json,
    row.replan_reason,
    row.supersedes_plan_id,
    row.created_by_agent_id,
    row.approved_by,
    row.created_at,
    row.version,
  ]);
}

function parsePlanRow(value: unknown): PlanRow {
  const row = storedRecord(value, 'plans');
  const parsed: PlanRow = Object.freeze({
    plan_id: concreteEntityId(storedUuid(row['plan_id'], 'plans.plan_id'), 'plans.plan_id'),
    project_id: concreteEntityId(
      storedUuid(row['project_id'], 'plans.project_id'),
      'plans.project_id',
    ),
    plan_version: storedUnsignedInteger(row['plan_version'], 'plans.plan_version', 4_294_967_295),
    status: storedEnum(row['status'], PLAN_STATUSES, 'plans.status'),
    title: storedString(row['title'], 'plans.title'),
    content_md: storedString(row['content_md'], 'plans.content_md'),
    council_session_id: optionalEntityId(
      storedUuid(row['council_session_id'], 'plans.council_session_id'),
      'plans.council_session_id',
    ),
    team_json: storedJsonValue(row['team_json'], 'plans.team_json'),
    scenarios_json: storedJsonValue(row['scenarios_json'], 'plans.scenarios_json'),
    replan_reason: storedString(row['replan_reason'], 'plans.replan_reason'),
    supersedes_plan_id: optionalEntityId(
      storedUuid(row['supersedes_plan_id'], 'plans.supersedes_plan_id'),
      'plans.supersedes_plan_id',
    ),
    created_by_agent_id: concreteEntityId(
      storedUuid(row['created_by_agent_id'], 'plans.created_by_agent_id'),
      'plans.created_by_agent_id',
    ),
    approved_by: storedString(row['approved_by'], 'plans.approved_by'),
    created_at: storedDateTime(row['created_at'], 'plans.created_at'),
    version: storedUInt64(row['version'], 'plans.version'),
  });
  if (row['row_hash'] !== undefined) {
    const hash = storedString(row['row_hash'], 'plans.row_hash');
    if (hash !== '' && (!ROW_HASH.test(hash) || hash !== planRowHash(parsed))) {
      throw new StoredRecordError('plans.row_hash integrity', { hash, row: parsed });
    }
  }
  return parsed;
}

function toInsertRow(row: PlanRow): Record<string, unknown> {
  return {
    ...row,
    team_json: serializeJsonValue(row.team_json, 'plans.team_json'),
    scenarios_json: serializeJsonValue(row.scenarios_json, 'plans.scenarios_json'),
    row_hash: planRowHash(row),
  };
}

async function readPlanVersion(
  ch: ClickHouseClient,
  projectId: EntityId,
  planId: EntityId,
  version: UInt64String,
): Promise<PlanRow[]> {
  const result = await ch.query({
    query: `SELECT ${PLAN_COLUMNS} FROM plans
      WHERE project_id = {projectId:UUID} AND plan_id = {planId:UUID}
        AND version = {version:UInt64}`,
    query_params: { projectId, planId, version },
    format: 'JSONEachRow',
  });
  return (await result.json<unknown>()).map(parsePlanRow);
}

export async function getLatestPlan(
  ch: ClickHouseClient,
  projectId: string,
  planId: string,
): Promise<PlanRow | null> {
  const project = concreteEntityId(projectId, 'projectId');
  const plan = concreteEntityId(planId, 'planId');
  const result = await ch.query({
    query: `SELECT ${PLAN_COLUMNS} FROM plans
      WHERE project_id = {projectId:UUID} AND plan_id = {planId:UUID}
      ORDER BY version DESC`,
    query_params: { projectId: project, planId: plan },
    format: 'JSONEachRow',
  });
  const rows = (await result.json<unknown>()).map(parsePlanRow);
  if (rows.length === 0) return null;
  const maximum = rows[0]!.version;
  return reconcileVersionedWrite(
    `plan:${plan}`,
    rows[0]!,
    rows.filter((row) => row.version === maximum),
  );
}

export async function listLatestPlansByStatus(
  ch: ClickHouseClient,
  projectId: string,
  status: PlanStatus,
): Promise<PlanRow[]> {
  const project = concreteEntityId(projectId, 'projectId');
  const state = storedEnum(status, PLAN_STATUSES, 'planStatus');
  const result = await ch.query({
    query: `SELECT ${PLAN_COLUMNS} FROM plans
      WHERE project_id = {projectId:UUID}
        AND (plan_id, version) IN (
          SELECT plan_id, max(version) FROM plans
          WHERE project_id = {projectId:UUID}
          GROUP BY plan_id
        )
      ORDER BY plan_id`,
    query_params: { projectId: project },
    format: 'JSONEachRow',
  });
  const grouped = new Map<string, PlanRow[]>();
  for (const row of (await result.json<unknown>()).map(parsePlanRow)) {
    const rows = grouped.get(row.plan_id) ?? [];
    rows.push(row);
    grouped.set(row.plan_id, rows);
  }
  return [...grouped.values()]
    .map((rows) => reconcileVersionedWrite(`plan:${rows[0]!.plan_id}`, rows[0]!, rows))
    .filter((row) => row.status === state);
}

export async function createPlan(ch: ClickHouseClient, input: CreatePlanInput): Promise<PlanRow> {
  const projectId = concreteEntityId(input.project_id, 'projectId');
  const planId = concreteEntityId(input.plan_id, 'planId');
  const current = await getLatestPlan(ch, projectId, planId);
  if (current !== null) {
    const desired = parsePlanRow({
      ...input,
      project_id: projectId,
      plan_id: planId,
      team_json: serializeJsonValue(input.team_json, 'plans.team_json'),
      scenarios_json: serializeJsonValue(input.scenarios_json, 'plans.scenarios_json'),
      version: current.version,
    });
    if (canonicalSha256V1(current) === canonicalSha256V1(desired)) return current;
    throw new RepositoryConflictError(`plan zaten var: ${planId}`);
  }
  const row = parsePlanRow({
    ...input,
    project_id: projectId,
    plan_id: planId,
    team_json: serializeJsonValue(input.team_json, 'plans.team_json'),
    scenarios_json: serializeJsonValue(input.scenarios_json, 'plans.scenarios_json'),
    version: nextRepositoryVersion(),
  });
  try {
    await ch.insert({ table: 'plans', values: [toInsertRow(row)], format: 'JSONEachRow' });
  } catch (error) {
    const observed = await readAfterUncertainWrite(
      `plan:${planId}`,
      error,
      () => readPlanVersion(ch, projectId, planId, row.version),
    );
    if (observed.length > 0) return reconcileVersionedWrite(`plan:${planId}`, row, observed);
    throw uncertainWriteError(`plan:${planId}`, error);
  }
  const observed = await readRowsAfterAcknowledgedWrite(
    `plan:${planId}`,
    row,
    () => readPlanVersion(ch, projectId, planId, row.version),
  );
  return reconcileVersionedWrite(`plan:${planId}`, row, observed);
}

export async function appendPlanVersion(
  ch: ClickHouseClient,
  input: AppendPlanVersionInput,
): Promise<PlanRow> {
  const projectId = concreteEntityId(input.next.project_id, 'projectId');
  const planId = concreteEntityId(input.next.plan_id, 'planId');
  const current = await getLatestPlan(ch, projectId, planId);
  if (current === null) throw new RepositoryNotFoundError(`plan bulunamadi: ${planId}`);
  const expectedVersion = storedUInt64(input.expectedVersion, 'expectedVersion');
  if (current.version !== expectedVersion) {
    if (BigInt(current.version) < BigInt(expectedVersion)) {
      assertExpectedVersion(`plan:${planId}`, current.version, expectedVersion);
    }
    const desired = parsePlanRow({
      ...input.next,
      project_id: projectId,
      plan_id: planId,
      team_json: serializeJsonValue(input.next.team_json, 'plans.team_json'),
      scenarios_json: serializeJsonValue(input.next.scenarios_json, 'plans.scenarios_json'),
      version: current.version,
    });
    if (
      canonicalSha256V1(current) === canonicalSha256V1(desired)
    ) return current;
    assertExpectedVersion(`plan:${planId}`, current.version, expectedVersion);
  }
  const row = parsePlanRow({
    ...input.next,
    project_id: projectId,
    plan_id: planId,
    team_json: serializeJsonValue(input.next.team_json, 'plans.team_json'),
    scenarios_json: serializeJsonValue(input.next.scenarios_json, 'plans.scenarios_json'),
    version: nextRepositoryVersion(current.version),
  });
  if (row.created_at !== current.created_at || row.plan_version !== current.plan_version) {
    throw new RepositoryConflictError(`plan kimlik alanlari degistirilemez: ${planId}`);
  }
  try {
    await ch.insert({ table: 'plans', values: [toInsertRow(row)], format: 'JSONEachRow' });
  } catch (error) {
    const observed = await readAfterUncertainWrite(
      `plan:${planId}`,
      error,
      () => readPlanVersion(ch, projectId, planId, row.version),
    );
    if (observed.length > 0) return reconcileVersionedWrite(`plan:${planId}`, row, observed);
    throw uncertainWriteError(`plan:${planId}`, error);
  }
  const observed = await readRowsAfterAcknowledgedWrite(
    `plan:${planId}`,
    row,
    () => readPlanVersion(ch, projectId, planId, row.version),
  );
  return reconcileVersionedWrite(`plan:${planId}`, row, observed);
}
