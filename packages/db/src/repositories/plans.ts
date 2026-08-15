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
  readonly observed_at: string;
  readonly version: UInt64String;
}

export type CreatePlanInput = Omit<PlanRow, 'version' | 'observed_at'>;

export interface AppendPlanVersionInput {
  readonly expectedVersion: UInt64String;
  readonly next: Omit<PlanRow, 'version' | 'observed_at'>;
}

const ROW_HASH = /^[0-9a-f]{64}$/;
const EPOCH = '1970-01-01T00:00:00.000Z';
const PLAN_OBSERVED_AT = `if(
  acceptance.observation_count > 0,
  acceptance.observed_at,
  if(p.observed_at = toDateTime64(0, 3, 'UTC'), p.created_at, p.observed_at)
)`;
const PLAN_COLUMNS = `p.plan_id AS plan_id, p.project_id AS project_id,
  p.plan_version AS plan_version, p.status AS status, p.title AS title,
  p.content_md AS content_md, p.council_session_id AS council_session_id,
  p.team_json AS team_json, p.scenarios_json AS scenarios_json,
  p.replan_reason AS replan_reason, p.supersedes_plan_id AS supersedes_plan_id,
  p.created_by_agent_id AS created_by_agent_id, p.approved_by AS approved_by,
  p.created_at AS created_at, ${PLAN_OBSERVED_AT} AS observed_at,
  p.version AS version, p.row_hash AS row_hash`;
function planFrom(acceptanceScope: 'plan' | 'project'): string {
  const observationWhere = acceptanceScope === 'plan'
    ? 'WHERE project_id = {projectId:UUID} AND plan_id = {planId:UUID}'
    : 'WHERE project_id = {projectId:UUID}';
  return `plans AS p
  LEFT JOIN (
    SELECT project_id, plan_id, version, row_hash,
      min(observed_at) AS observed_at, count() AS observation_count
    FROM plan_acceptance_observations
    ${observationWhere}
    GROUP BY project_id, plan_id, version, row_hash
  ) AS acceptance
  ON acceptance.project_id = p.project_id
    AND acceptance.plan_id = p.plan_id
    AND acceptance.version = p.version
    AND acceptance.row_hash = p.row_hash`;
}

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

function planCallerContentHash(row: PlanRow): string {
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
  ]);
}

function reconcilePlanVersion(
  entity: string,
  observed: readonly PlanRow[],
  expected?: PlanRow,
): PlanRow {
  if (observed.length === 0) {
    throw new RepositoryConflictError(`${entity} surumu okunamadi`);
  }
  const baseline = expected ?? observed[0]!;
  const contentHash = planCallerContentHash(baseline);
  if (observed.some((row) => (
    row.version !== baseline.version || planCallerContentHash(row) !== contentHash
  ))) {
    throw new RepositoryConflictError(
      `${entity} ayni kimlik ve surum icin farkli caller icerigi barindiriyor`,
    );
  }
  return [...observed].sort((left, right) => {
    const byObservedAt = left.observed_at.localeCompare(right.observed_at);
    if (byObservedAt !== 0) return byObservedAt;
    return canonicalSha256V1(left).localeCompare(canonicalSha256V1(right));
  })[0]!;
}

function parsePlanRow(value: unknown): PlanRow {
  const row = storedRecord(value, 'plans');
  const createdAt = storedDateTime(row['created_at'], 'plans.created_at');
  const storedObservedAt = row['observed_at'] === undefined
    ? EPOCH
    : storedDateTime(row['observed_at'], 'plans.observed_at');
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
    created_at: createdAt,
    observed_at: storedObservedAt === EPOCH ? createdAt : storedObservedAt,
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

function clickHouseDateTime(value: string): string {
  return value.replace('T', ' ').replace('Z', '');
}

/**
 * Plans are the one versioned repository whose temporal cutoff is based on
 * database acceptance. Keep regular repositories on JSONEachRow, but use this
 * narrow INSERT SELECT so ClickHouse, not a pre-network caller clock, assigns
 * observed_at. The append-only observation table retains every acceptance and
 * read queries fold its minimum for exact logical retries. The max+1ms floor
 * orders server acceptances inside the same DateTime64(3) tick.
 */
async function insertPlanAtAcceptance(ch: ClickHouseClient, row: PlanRow): Promise<void> {
  await ch.command({
    query: `INSERT INTO plans (
        plan_id, project_id, plan_version, status, title, content_md,
        council_session_id, team_json, scenarios_json, replan_reason,
        supersedes_plan_id, created_by_agent_id, approved_by, created_at,
        observed_at, version, row_hash
      )
      SELECT
        {planId:UUID}, {projectId:UUID}, {planVersion:UInt32}, {status:String},
        {title:String}, {contentMd:String}, {councilSessionId:UUID}, {teamJson:String},
        {scenariosJson:String}, {replanReason:String}, {supersedesPlanId:UUID},
        {createdByAgentId:UUID}, {approvedBy:String},
        {createdAt:DateTime64(3, 'UTC')},
        greatest(
          now64(3, 'UTC'),
          ifNull(
            (
              SELECT maxOrNull(if(
                observed_at = toDateTime64(0, 3, 'UTC'),
                created_at,
                observed_at
              )) + INTERVAL 1 MILLISECOND
              FROM plans
              WHERE project_id = {projectId:UUID} AND plan_id = {planId:UUID}
            ),
            now64(3, 'UTC')
          )
        ),
        {version:UInt64}, {rowHash:String}`,
    query_params: {
      planId: row.plan_id,
      projectId: row.project_id,
      planVersion: row.plan_version,
      status: row.status,
      title: row.title,
      contentMd: row.content_md,
      councilSessionId: row.council_session_id,
      teamJson: serializeJsonValue(row.team_json, 'plans.team_json'),
      scenariosJson: serializeJsonValue(row.scenarios_json, 'plans.scenarios_json'),
      replanReason: row.replan_reason,
      supersedesPlanId: row.supersedes_plan_id,
      createdByAgentId: row.created_by_agent_id,
      approvedBy: row.approved_by,
      createdAt: clickHouseDateTime(row.created_at),
      version: row.version,
      rowHash: planRowHash(row),
    },
  });
}

async function readPlanVersion(
  ch: ClickHouseClient,
  projectId: EntityId,
  planId: EntityId,
  version: UInt64String,
): Promise<PlanRow[]> {
  const result = await ch.query({
    query: `SELECT ${PLAN_COLUMNS} FROM ${planFrom('plan')}
      WHERE p.project_id = {projectId:UUID} AND p.plan_id = {planId:UUID}
        AND p.version = {version:UInt64}`,
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
    query: `SELECT ${PLAN_COLUMNS} FROM ${planFrom('plan')}
      WHERE p.project_id = {projectId:UUID} AND p.plan_id = {planId:UUID}
      ORDER BY p.version DESC`,
    query_params: { projectId: project, planId: plan },
    format: 'JSONEachRow',
  });
  const rows = (await result.json<unknown>()).map(parsePlanRow);
  if (rows.length === 0) return null;
  const maximum = rows[0]!.version;
  return reconcilePlanVersion(
    `plan:${plan}`,
    rows.filter((row) => row.version === maximum),
  );
}

export async function getPlanAsOf(
  ch: ClickHouseClient,
  projectId: string,
  planId: string,
  cutoffAt: string,
): Promise<PlanRow | null> {
  const project = concreteEntityId(projectId, 'projectId');
  const plan = concreteEntityId(planId, 'planId');
  const cutoff = storedDateTime(cutoffAt, 'cutoffAt').replace('T', ' ').replace('Z', '');
  const result = await ch.query({
    query: `SELECT ${PLAN_COLUMNS} FROM ${planFrom('plan')}
      WHERE p.project_id = {projectId:UUID} AND p.plan_id = {planId:UUID}
        AND ${PLAN_OBSERVED_AT} <= {cutoffAt:DateTime64(3, 'UTC')}
      ORDER BY p.version DESC`,
    query_params: { projectId: project, planId: plan, cutoffAt: cutoff },
    format: 'JSONEachRow',
  });
  const rows = (await result.json<unknown>()).map(parsePlanRow);
  if (rows.length === 0) return null;
  const maximum = rows[0]!.version;
  return reconcilePlanVersion(
    `plan:${plan}@asOf`,
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
    query: `SELECT ${PLAN_COLUMNS} FROM ${planFrom('project')}
      WHERE p.project_id = {projectId:UUID}
        AND (p.plan_id, p.version) IN (
          SELECT plan_id, max(version) FROM plans
          WHERE project_id = {projectId:UUID}
          GROUP BY plan_id
        )
      ORDER BY p.plan_id ASC, observed_at ASC`,
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
    .map((rows) => {
      const maximum = rows[0]!.version;
      return reconcilePlanVersion(
        `plan:${rows[0]!.plan_id}`,
        rows.filter((row) => row.version === maximum),
      );
    })
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
      observed_at: current.observed_at,
      version: current.version,
    });
    if (planCallerContentHash(current) === planCallerContentHash(desired)) return current;
    throw new RepositoryConflictError(`plan zaten var: ${planId}`);
  }
  const row = parsePlanRow({
    ...input,
    project_id: projectId,
    plan_id: planId,
    team_json: serializeJsonValue(input.team_json, 'plans.team_json'),
    scenarios_json: serializeJsonValue(input.scenarios_json, 'plans.scenarios_json'),
    observed_at: EPOCH,
    version: nextRepositoryVersion(),
  });
  try {
    await insertPlanAtAcceptance(ch, row);
  } catch (error) {
    const observed = await readAfterUncertainWrite(
      `plan:${planId}`,
      error,
      () => readPlanVersion(ch, projectId, planId, row.version),
    );
    if (observed.length > 0) return reconcilePlanVersion(`plan:${planId}`, observed, row);
    throw uncertainWriteError(`plan:${planId}`, error);
  }
  const observed = await readRowsAfterAcknowledgedWrite(
    `plan:${planId}`,
    row,
    () => readPlanVersion(ch, projectId, planId, row.version),
  );
  return reconcilePlanVersion(`plan:${planId}`, observed, row);
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
      observed_at: current.observed_at,
      version: current.version,
    });
    if (planCallerContentHash(current) === planCallerContentHash(desired)) return current;
    assertExpectedVersion(`plan:${planId}`, current.version, expectedVersion);
  }
  const row = parsePlanRow({
    ...input.next,
    project_id: projectId,
    plan_id: planId,
    team_json: serializeJsonValue(input.next.team_json, 'plans.team_json'),
    scenarios_json: serializeJsonValue(input.next.scenarios_json, 'plans.scenarios_json'),
    observed_at: EPOCH,
    version: nextRepositoryVersion(current.version),
  });
  if (row.created_at !== current.created_at || row.plan_version !== current.plan_version) {
    throw new RepositoryConflictError(`plan kimlik alanlari degistirilemez: ${planId}`);
  }
  try {
    await insertPlanAtAcceptance(ch, row);
  } catch (error) {
    const observed = await readAfterUncertainWrite(
      `plan:${planId}`,
      error,
      () => readPlanVersion(ch, projectId, planId, row.version),
    );
    if (observed.length > 0) return reconcilePlanVersion(`plan:${planId}`, observed, row);
    throw uncertainWriteError(`plan:${planId}`, error);
  }
  const observed = await readRowsAfterAcknowledgedWrite(
    `plan:${planId}`,
    row,
    () => readPlanVersion(ch, projectId, planId, row.version),
  );
  return reconcilePlanVersion(`plan:${planId}`, observed, row);
}
