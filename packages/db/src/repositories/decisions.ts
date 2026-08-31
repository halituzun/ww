import type { ClickHouseClient } from "@clickhouse/client";
import { canonicalSha256V1, type EntityId } from "@ww/shared";
import { concreteEntityId, storedUuid } from "./identifiers.js";
import {
  RepositoryNotFoundError,
  StoredRecordError,
  assertExpectedVersion,
  nextRepositoryVersion,
  readRowsAfterAcknowledgedWrite,
  storedDateTime,
  storedEnum,
  storedRecord,
  storedString,
  storedUInt64,
  storedUnsignedInteger,
  uncertainWriteError,
  type UInt64String,
} from "./types.js";

export const DECISION_STATUSES = ["accepted", "rejected", "modified"] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export interface DecisionRow {
  readonly decision_id: EntityId;
  readonly project_id: EntityId;
  readonly topic: string;
  readonly decision: DecisionStatus;
  readonly rationale: string;
  readonly dissent: string;
  readonly turn_number: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly version: UInt64String;
}

export type CreateDecisionInput = Omit<DecisionRow, "version" | "updated_at">;

export interface AppendDecisionVersionInput {
  readonly expectedVersion: UInt64String;
  readonly next: Omit<DecisionRow, "version" | "updated_at">;
}

const ROW_HASH = /^[0-9a-f]{64}$/;
const DECISION_COLUMNS = `decision_id, project_id, topic, decision, rationale, dissent, turn_number, created_at, updated_at, version, row_hash`;

function decisionRowHash(row: DecisionRow): string {
  return canonicalSha256V1([
    row.decision_id,
    row.project_id,
    row.topic,
    row.decision,
    row.rationale,
    row.dissent,
    row.turn_number,
    row.created_at,
    row.updated_at,
    row.version,
  ]);
}

function parseDecisionRow(raw: unknown): DecisionRow {
  const row = storedRecord(raw, "decisions");
  const parsed: DecisionRow = {
    decision_id: concreteEntityId(storedUuid(row["decision_id"], "decisions.decision_id"), "decisions.decision_id"),
    project_id: concreteEntityId(storedUuid(row["project_id"], "decisions.project_id"), "decisions.project_id"),
    topic: storedString(row["topic"], "decisions.topic"),
    decision: storedEnum(row["decision"], DECISION_STATUSES, "decisions.decision"),
    rationale: storedString(row["rationale"], "decisions.rationale"),
    dissent: storedString(row["dissent"], "decisions.dissent"),
    turn_number: storedUnsignedInteger(row["turn_number"], "decisions.turn_number", 255),
    created_at: storedDateTime(row["created_at"], "decisions.created_at"),
    updated_at: storedDateTime(row["updated_at"], "decisions.updated_at"),
    version: storedUInt64(row["version"], "decisions.version"),
  };
  if (row["row_hash"] !== undefined) {
    const hash = storedString(row["row_hash"], "decisions.row_hash");
    if (hash !== "" && (!ROW_HASH.test(hash) || hash !== decisionRowHash(parsed))) {
      throw new StoredRecordError("decisions.row_hash integrity", { hash, row: parsed });
    }
  }
  return parsed;
}

function toInsertRow(row: DecisionRow): Record<string, unknown> {
  return { ...row, row_hash: decisionRowHash(row) };
}

export async function createDecision(
  ch: ClickHouseClient,
  input: CreateDecisionInput,
): Promise<DecisionRow> {
  const row: DecisionRow = {
    ...input,
    updated_at: input.created_at,
    version: "1",
  };
  try {
    await ch.insert({
      table: "decisions",
      values: [toInsertRow(row)],
      format: "JSONEachRow",
    });
  } catch (error) {
    throw uncertainWriteError("decisions", error);
  }
  return row;
}

export async function listDecisions(
  ch: ClickHouseClient,
  projectId: EntityId,
): Promise<readonly DecisionRow[]> {
  const rs = await ch.query({
    query: `SELECT ${DECISION_COLUMNS} FROM decisions FINAL WHERE project_id = {projectId:UUID} ORDER BY turn_number ASC, created_at ASC`,
    query_params: { projectId },
    format: "JSONEachRow",
  });
  const rows = await rs.json<unknown[]>();
  return rows.map(parseDecisionRow);
}

export async function getDecision(
  ch: ClickHouseClient,
  projectId: EntityId,
  decisionId: EntityId,
): Promise<DecisionRow> {
  const rs = await ch.query({
    query: `SELECT ${DECISION_COLUMNS} FROM decisions FINAL WHERE project_id = {projectId:UUID} AND decision_id = {decisionId:UUID} LIMIT 1`,
    query_params: { projectId, decisionId },
    format: "JSONEachRow",
  });
  const rows = await rs.json<unknown[]>();
  if (rows.length === 0) {
    throw new RepositoryNotFoundError(`decisions/${decisionId} bulunamadi`);
  }
  return parseDecisionRow(rows[0]);
}
