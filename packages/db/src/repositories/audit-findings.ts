import type { ClickHouseClient } from '@clickhouse/client';
import {
  AUDIT_FINDING_STATUSES,
  AuditFindingSchema,
  NIL_UUID,
  canonicalJsonV1,
  canonicalSha256V1,
  type AuditFinding,
  type EntityId,
} from '@ww/shared';
import { concreteEntityId, optionalEntityId, storedUuid } from './identifiers.js';
import {
  RepositoryConflictError,
  RepositoryNotFoundError,
  RepositoryWriteError,
  StoredRecordError,
  assertExpectedVersion,
  nextRepositoryVersion,
  readRowsAfterAcknowledgedWrite,
  readAfterUncertainWrite,
  storedDateTime,
  storedJsonValue,
  storedRecord,
  storedString,
  storedStringArray,
  storedUInt64,
  storedUnsignedInteger,
  uncertainWriteError,
  type UInt64String,
} from './types.js';

export type AuditFindingStatus = (typeof AUDIT_FINDING_STATUSES)[number];

export interface AuditFindingRecord {
  readonly finding: AuditFinding;
  readonly finding_version: UInt64String;
  readonly finding_hash: string;
  readonly updated_at: string;
}

export interface CreateAuditFindingInput {
  readonly finding: AuditFinding;
  readonly updated_at: string;
}

export interface AppendAuditFindingVersionInput extends CreateAuditFindingInput {
  readonly expectedVersion: UInt64String;
}

interface StoredAuditFindingRow {
  readonly finding_id: string;
  readonly finding_version: UInt64String;
  readonly contract_version: number;
  readonly project_id: string;
  readonly task_id: string;
  readonly message_id: string;
  readonly profile: string;
  readonly rule_id: string;
  readonly rule_version: number;
  readonly severity: string;
  readonly summary: string;
  readonly evidence_refs: readonly string[];
  readonly status: string;
  readonly corrective_task_id: string;
  readonly resolution: string;
  readonly finding_json: string;
  readonly finding_hash: string;
  readonly created_at: string;
  readonly updated_at: string;
}

const FINDING_COLUMNS = `finding_id, finding_version, contract_version, project_id,
  task_id, message_id, profile, rule_id, rule_version, severity, summary,
  evidence_refs, status, corrective_task_id, resolution, finding_json,
  finding_hash, created_at, updated_at`;

function normalizeFinding(input: AuditFinding): AuditFinding {
  const finding = AuditFindingSchema.parse(input);
  return AuditFindingSchema.parse({
    ...finding,
    createdAt: storedDateTime(finding.createdAt, 'finding.createdAt'),
  });
}

function parseAuditFindingRow(value: unknown): AuditFindingRecord {
  const row = storedRecord(value, 'audit_findings');
  try {
    if (storedUnsignedInteger(row['contract_version'], 'audit_findings.contract_version') !== 1) {
      throw new StoredRecordError('audit_findings.contract_version', row['contract_version']);
    }
    const findingJson = storedString(row['finding_json'], 'audit_findings.finding_json');
    const finding = AuditFindingSchema.parse(
      storedJsonValue(findingJson, 'audit_findings.finding_json'),
    );
    const findingHash = storedString(row['finding_hash'], 'audit_findings.finding_hash');
    if (
      findingJson !== canonicalJsonV1(finding) ||
      findingHash !== canonicalSha256V1(finding)
    ) {
      throw new StoredRecordError('audit_findings finding integrity', row);
    }

    const taskId = optionalEntityId(
      storedUuid(row['task_id'], 'audit_findings.task_id'),
      'audit_findings.task_id',
    );
    const messageId = optionalEntityId(
      storedUuid(row['message_id'], 'audit_findings.message_id'),
      'audit_findings.message_id',
    );
    const correctiveTaskId = optionalEntityId(
      storedUuid(row['corrective_task_id'], 'audit_findings.corrective_task_id'),
      'audit_findings.corrective_task_id',
    );
    const evidenceRefs = storedStringArray(
      row['evidence_refs'],
      'audit_findings.evidence_refs',
    );
    const createdAt = storedDateTime(row['created_at'], 'audit_findings.created_at');
    const explicitMatches =
      concreteEntityId(
        storedUuid(row['finding_id'], 'audit_findings.finding_id'),
        'audit_findings.finding_id',
      ) === finding.findingId &&
      concreteEntityId(
        storedUuid(row['project_id'], 'audit_findings.project_id'),
        'audit_findings.project_id',
      ) === finding.projectId &&
      taskId === (finding.taskId ?? NIL_UUID) &&
      messageId === (finding.messageId ?? NIL_UUID) &&
      storedString(row['profile'], 'audit_findings.profile') === finding.profile &&
      storedString(row['rule_id'], 'audit_findings.rule_id') === finding.rule.ruleId &&
      storedUnsignedInteger(row['rule_version'], 'audit_findings.rule_version') ===
        finding.rule.ruleVersion &&
      storedString(row['severity'], 'audit_findings.severity') === finding.severity &&
      storedString(row['summary'], 'audit_findings.summary') === finding.summary &&
      canonicalSha256V1(evidenceRefs) === canonicalSha256V1(finding.evidenceRefs) &&
      storedString(row['status'], 'audit_findings.status') === finding.status &&
      correctiveTaskId === (finding.correctiveTaskId ?? NIL_UUID) &&
      storedString(row['resolution'], 'audit_findings.resolution') ===
        (finding.resolution ?? '') &&
      createdAt === finding.createdAt;
    if (!explicitMatches) {
      throw new StoredRecordError('audit_findings explicit projection', row);
    }
    return Object.freeze({
      finding,
      finding_version: storedUInt64(
        row['finding_version'],
        'audit_findings.finding_version',
      ),
      finding_hash: findingHash,
      updated_at: storedDateTime(row['updated_at'], 'audit_findings.updated_at'),
    });
  } catch (error) {
    if (error instanceof StoredRecordError) throw error;
    throw new StoredRecordError('audit_findings', error);
  }
}

function toStoredRow(record: AuditFindingRecord): StoredAuditFindingRow {
  const finding = normalizeFinding(record.finding);
  return {
    finding_id: finding.findingId,
    finding_version: record.finding_version,
    contract_version: 1,
    project_id: finding.projectId,
    task_id: finding.taskId ?? NIL_UUID,
    message_id: finding.messageId ?? NIL_UUID,
    profile: finding.profile,
    rule_id: finding.rule.ruleId,
    rule_version: finding.rule.ruleVersion,
    severity: finding.severity,
    summary: finding.summary,
    evidence_refs: finding.evidenceRefs,
    status: finding.status,
    corrective_task_id: finding.correctiveTaskId ?? NIL_UUID,
    resolution: finding.resolution ?? '',
    finding_json: canonicalJsonV1(finding),
    finding_hash: canonicalSha256V1(finding),
    created_at: finding.createdAt,
    updated_at: record.updated_at,
  };
}

async function readFindingVersion(
  ch: ClickHouseClient,
  projectId: EntityId,
  findingId: EntityId,
  findingVersion: UInt64String,
): Promise<AuditFindingRecord[]> {
  const result = await ch.query({
    query: `SELECT ${FINDING_COLUMNS} FROM audit_findings
      WHERE project_id = {projectId:UUID} AND finding_id = {findingId:UUID}
        AND finding_version = {findingVersion:UInt64}`,
    query_params: { projectId, findingId, findingVersion },
    format: 'JSONEachRow',
  });
  return (await result.json<unknown>()).map(parseAuditFindingRow);
}

function reconcileFinding(
  expected: AuditFindingRecord,
  observed: readonly AuditFindingRecord[],
): AuditFindingRecord {
  if (observed.length === 0) {
    throw new RepositoryWriteError(`finding:${expected.finding.findingId} yazimi okunamadi`);
  }
  const expectedHash = canonicalSha256V1(expected);
  if (observed.some((row) => canonicalSha256V1(row) !== expectedHash)) {
    throw new RepositoryConflictError(
      `finding:${expected.finding.findingId} ayni surum icin farkli icerik barindiriyor`,
    );
  }
  return expected;
}

async function insertAndReconcile(
  ch: ClickHouseClient,
  expected: AuditFindingRecord,
): Promise<AuditFindingRecord> {
  const entity = `finding:${expected.finding.findingId}`;
  const read = (): Promise<AuditFindingRecord[]> => readFindingVersion(
    ch,
    expected.finding.projectId,
    expected.finding.findingId,
    expected.finding_version,
  );
  try {
    await ch.insert({
      table: 'audit_findings',
      values: [toStoredRow(expected)],
      format: 'JSONEachRow',
    });
  } catch (error) {
    const observed = await readAfterUncertainWrite(entity, error, read);
    if (observed.length === 0) throw uncertainWriteError(entity, error);
    return reconcileFinding(expected, observed);
  }
  const observed = await readRowsAfterAcknowledgedWrite(entity, expected, read);
  return reconcileFinding(expected, observed);
}

async function latestFindingRows(
  ch: ClickHouseClient,
  projectId: EntityId,
  findingId: EntityId,
): Promise<AuditFindingRecord[]> {
  const result = await ch.query({
    query: `SELECT ${FINDING_COLUMNS} FROM audit_findings
      WHERE project_id = {projectId:UUID} AND finding_id = {findingId:UUID}
        AND finding_version = (
          SELECT max(finding_version) FROM audit_findings
          WHERE project_id = {projectId:UUID} AND finding_id = {findingId:UUID}
        )`,
    query_params: { projectId, findingId },
    format: 'JSONEachRow',
  });
  return (await result.json<unknown>()).map(parseAuditFindingRow);
}

export async function getLatestAuditFinding(
  ch: ClickHouseClient,
  projectId: string,
  findingId: string,
): Promise<AuditFindingRecord | null> {
  const project = concreteEntityId(projectId, 'projectId');
  const finding = concreteEntityId(findingId, 'findingId');
  const rows = await latestFindingRows(ch, project, finding);
  if (rows.length === 0) return null;
  return reconcileFinding(rows[0]!, rows);
}

export async function listLatestAuditFindingsByStatus(
  ch: ClickHouseClient,
  projectId: string,
  status: AuditFindingStatus,
): Promise<AuditFindingRecord[]> {
  const project = concreteEntityId(projectId, 'projectId');
  if (!(AUDIT_FINDING_STATUSES as readonly string[]).includes(status)) {
    throw new StoredRecordError('findingStatus', status);
  }
  const result = await ch.query({
    query: `SELECT ${FINDING_COLUMNS} FROM audit_findings
      WHERE project_id = {projectId:UUID}
        AND (finding_id, finding_version) IN (
          SELECT finding_id, max(finding_version)
          FROM audit_findings
          WHERE project_id = {projectId:UUID}
          GROUP BY finding_id
        )
      ORDER BY finding_id`,
    query_params: { projectId: project },
    format: 'JSONEachRow',
  });
  const grouped = new Map<string, AuditFindingRecord[]>();
  for (const row of (await result.json<unknown>()).map(parseAuditFindingRow)) {
    const rows = grouped.get(row.finding.findingId) ?? [];
    rows.push(row);
    grouped.set(row.finding.findingId, rows);
  }
  return [...grouped.values()]
    .map((rows) => reconcileFinding(rows[0]!, rows))
    .filter((row) => row.finding.status === status);
}

export async function createAuditFinding(
  ch: ClickHouseClient,
  input: CreateAuditFindingInput,
): Promise<AuditFindingRecord> {
  const finding = normalizeFinding(input.finding);
  const updatedAt = storedDateTime(input.updated_at, 'updatedAt');
  const current = await getLatestAuditFinding(ch, finding.projectId, finding.findingId);
  if (current !== null) {
    if (
      canonicalSha256V1(current.finding) === canonicalSha256V1(finding) &&
      current.updated_at === updatedAt
    ) return current;
    throw new RepositoryConflictError(`finding zaten farkli icerikle var: ${finding.findingId}`);
  }
  const expected: AuditFindingRecord = Object.freeze({
    finding,
    finding_version: nextRepositoryVersion(),
    finding_hash: canonicalSha256V1(finding),
    updated_at: updatedAt,
  });
  return insertAndReconcile(ch, expected);
}

export async function appendAuditFindingVersion(
  ch: ClickHouseClient,
  input: AppendAuditFindingVersionInput,
): Promise<AuditFindingRecord> {
  const finding = normalizeFinding(input.finding);
  const updatedAt = storedDateTime(input.updated_at, 'updatedAt');
  const current = await getLatestAuditFinding(ch, finding.projectId, finding.findingId);
  if (current === null) {
    throw new RepositoryNotFoundError(`finding bulunamadi: ${finding.findingId}`);
  }
  const expectedVersion = storedUInt64(input.expectedVersion, 'expectedVersion');
  if (current.finding_version !== expectedVersion) {
    if (BigInt(current.finding_version) < BigInt(expectedVersion)) {
      assertExpectedVersion(
        `finding:${finding.findingId}`,
        current.finding_version,
        expectedVersion,
      );
    }
    if (
      canonicalSha256V1(current.finding) === canonicalSha256V1(finding) &&
      current.updated_at === updatedAt
    ) return current;
    assertExpectedVersion(
      `finding:${finding.findingId}`,
      current.finding_version,
      expectedVersion,
    );
  }
  if (
    finding.projectId !== current.finding.projectId ||
    finding.findingId !== current.finding.findingId ||
    finding.createdAt !== current.finding.createdAt
  ) {
    throw new RepositoryConflictError(`finding kimligi degistirilemez: ${finding.findingId}`);
  }
  const expected: AuditFindingRecord = Object.freeze({
    finding,
    finding_version: nextRepositoryVersion(current.finding_version),
    finding_hash: canonicalSha256V1(finding),
    updated_at: updatedAt,
  });
  return insertAndReconcile(ch, expected);
}
