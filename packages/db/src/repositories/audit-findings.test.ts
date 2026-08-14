import { randomUUID } from 'node:crypto';
import type { ClickHouseClient } from '@clickhouse/client';
import { NIL_UUID, canonicalJsonV1, canonicalSha256V1, type AuditFinding } from '@ww/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCh } from '../client.js';
import { runMigrations } from '../migrate.js';
import { clickhouseUp } from '../testutil.js';
import {
  appendAuditFindingVersion,
  createAuditFinding,
  getLatestAuditFinding,
  listLatestAuditFindingsByStatus,
} from './audit-findings.js';
import {
  RepositoryConflictError,
  RepositoryNotFoundError,
  StoredRecordError,
} from './types.js';

const up = await clickhouseUp();

function throwAfterAcceptedInsert(ch: ClickHouseClient): ClickHouseClient {
  return {
    query: ch.query.bind(ch),
    insert: async (options: Parameters<ClickHouseClient['insert']>[0]) => {
      await ch.insert(options);
      throw new Error('simulated timeout after accepted insert');
    },
  } as unknown as ClickHouseClient;
}

describe.skipIf(!up)('audit findings repository', () => {
  const db = `ww_test_findings_${Date.now()}_${process.pid}`;
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

  function finding(): AuditFinding {
    return {
      findingId: randomUUID(),
      projectId: randomUUID(),
      profile: 'communication_audit',
      rule: { ruleId: 'COMM-001', ruleVersion: 1 },
      severity: 'high',
      summary: 'direct route violated',
      evidenceRefs: ['message:1'],
      status: 'open',
      createdAt: '2026-08-14T15:00:00+03:00',
    };
  }

  it('version appendini, UTC normalizasyonunu ve uncertain insert retryını uzlaştırır', async () => {
    const input = finding();
    const initialInput = { finding: input, updated_at: '2026-08-14T15:00:00+03:00' };
    const initial = await createAuditFinding(throwAfterAcceptedInsert(ch), initialInput);
    expect(initial.finding.createdAt).toBe('2026-08-14T12:00:00.000Z');
    expect(initial.updated_at).toBe('2026-08-14T12:00:00.000Z');
    expect(await createAuditFinding(ch, initialInput)).toEqual(initial);

    const resolveInput = {
      expectedVersion: initial.finding_version,
      finding: { ...initial.finding, status: 'resolved' as const, resolution: 'fixed' },
      updated_at: '2026-08-14T15:01:00+03:00',
    };
    const resolved = await appendAuditFindingVersion(throwAfterAcceptedInsert(ch), resolveInput);
    expect(await appendAuditFindingVersion(ch, resolveInput)).toEqual(resolved);
    expect(await listLatestAuditFindingsByStatus(ch, input.projectId, 'open')).toEqual([]);
    expect(await listLatestAuditFindingsByStatus(ch, input.projectId, 'resolved'))
      .toEqual([resolved]);
  });

  it('aynı finding ID için farklı create içeriğini reddeder', async () => {
    const input = finding();
    await createAuditFinding(ch, { finding: input, updated_at: input.createdAt });
    await expect(createAuditFinding(ch, {
      finding: { ...input, summary: 'different' },
      updated_at: input.createdAt,
    })).rejects.toBeInstanceOf(RepositoryConflictError);
  });

  it('eksik finding icin appendi not-found olarak reddeder', async () => {
    const missing = finding();
    await expect(appendAuditFindingVersion(ch, {
      expectedVersion: '1',
      finding: missing,
      updated_at: missing.createdAt,
    })).rejects.toBeInstanceOf(RepositoryNotFoundError);
  });

  it('latest aynı-version divergent finding satırını reddeder', async () => {
    const initial = await createAuditFinding(ch, {
      finding: finding(),
      updated_at: '2026-08-14T12:00:00.000Z',
    });
    const divergent = { ...initial.finding, status: 'dismissed' as const };
    await ch.insert({
      table: 'audit_findings',
      values: [{
        finding_id: divergent.findingId,
        finding_version: initial.finding_version,
        contract_version: 1,
        project_id: divergent.projectId,
        task_id: NIL_UUID,
        message_id: NIL_UUID,
        profile: divergent.profile,
        rule_id: divergent.rule.ruleId,
        rule_version: divergent.rule.ruleVersion,
        severity: divergent.severity,
        summary: divergent.summary,
        evidence_refs: divergent.evidenceRefs,
        status: divergent.status,
        corrective_task_id: NIL_UUID,
        resolution: '',
        finding_json: canonicalJsonV1(divergent),
        finding_hash: canonicalSha256V1(divergent),
        created_at: divergent.createdAt,
        updated_at: initial.updated_at,
      }],
      format: 'JSONEachRow',
    });
    await expect(getLatestAuditFinding(ch, divergent.projectId, divergent.findingId))
      .rejects.toBeInstanceOf(RepositoryConflictError);
  });

  it('bozuk finding JSON kaydını sızdırmaz', async () => {
    const input = finding();
    await ch.insert({
      table: 'audit_findings',
      values: [{
        finding_id: input.findingId,
        finding_version: '1',
        contract_version: 1,
        project_id: input.projectId,
        task_id: NIL_UUID,
        message_id: NIL_UUID,
        profile: input.profile,
        rule_id: input.rule.ruleId,
        rule_version: input.rule.ruleVersion,
        severity: input.severity,
        summary: input.summary,
        evidence_refs: input.evidenceRefs,
        status: input.status,
        corrective_task_id: NIL_UUID,
        resolution: '',
        finding_json: '{bad-json',
        finding_hash: canonicalSha256V1(input),
        created_at: input.createdAt,
        updated_at: input.createdAt,
      }],
      format: 'JSONEachRow',
    });
    await expect(getLatestAuditFinding(ch, input.projectId, input.findingId))
      .rejects.toBeInstanceOf(StoredRecordError);
  });
});
