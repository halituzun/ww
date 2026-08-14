import { randomUUID } from 'node:crypto';
import { NIL_UUID, canonicalSha256V1 } from '@ww/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCh, type ClickHouseClient } from '../client.js';
import { runMigrations } from '../migrate.js';
import { clickhouseUp } from '../testutil.js';
import {
  appendPlanVersion,
  createPlan,
  getLatestPlan,
  listLatestPlansByStatus,
  type CreatePlanInput,
  type PlanRow,
} from './plans.js';
import { RepositoryConflictError } from './types.js';

const up = await clickhouseUp();

describe.skipIf(!up)('plans repository', () => {
  const db = `ww_test_plans_${Date.now()}_${process.pid}`;
  let ch: ClickHouseClient;

  const rowHash = (row: PlanRow): string => canonicalSha256V1([
    row.plan_id, row.project_id, row.plan_version, row.status, row.title,
    row.content_md, row.council_session_id, row.team_json, row.scenarios_json,
    row.replan_reason, row.supersedes_plan_id, row.created_by_agent_id,
    row.approved_by, row.created_at, row.version,
  ]);

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

  function plan(): CreatePlanInput {
    return {
      plan_id: randomUUID(),
      project_id: randomUUID(),
      plan_version: 1,
      status: 'proposed',
      title: 'Plan',
      content_md: '# Plan',
      council_session_id: NIL_UUID,
      team_json: { coding: 2 },
      scenarios_json: [{ name: 'happy path' }],
      replan_reason: '',
      supersedes_plan_id: NIL_UUID,
      created_by_agent_id: randomUUID(),
      approved_by: '',
      created_at: new Date().toISOString(),
    };
  }

  it('en yeni plan surumunu dondurur ve stale statusu filtrelemez', async () => {
    const initial = await createPlan(ch, plan());
    const approved = await appendPlanVersion(ch, {
      expectedVersion: initial.version,
      next: { ...initial, status: 'approved', approved_by: 'user' },
    });
    expect((await getLatestPlan(ch, initial.project_id, initial.plan_id))?.status).toBe('approved');
    expect(await listLatestPlansByStatus(ch, initial.project_id, 'proposed')).toEqual([]);
    expect((await listLatestPlansByStatus(ch, initial.project_id, 'approved'))[0]?.version).toBe(
      approved.version,
    );
  });

  it('max surum retry kopyasini katlar ve divergent tie kaydini fail-closed reddeder', async () => {
    const initial = await createPlan(ch, plan());
    const stored = {
      ...initial,
      team_json: JSON.stringify(initial.team_json),
      scenarios_json: JSON.stringify(initial.scenarios_json),
      row_hash: rowHash(initial),
    };
    await ch.insert({ table: 'plans', values: [stored], format: 'JSONEachRow' });
    expect(await getLatestPlan(ch, initial.project_id, initial.plan_id)).toEqual(initial);

    const divergent = { ...initial, title: 'divergent' };
    await ch.insert({
      table: 'plans',
      values: [{ ...stored, title: divergent.title, row_hash: rowHash(divergent) }],
      format: 'JSONEachRow',
    });
    await ch.command({ query: 'OPTIMIZE TABLE plans FINAL' });
    await expect(getLatestPlan(ch, initial.project_id, initial.plan_id))
      .rejects.toBeInstanceOf(RepositoryConflictError);
    await expect(listLatestPlansByStatus(ch, initial.project_id, initial.status))
      .rejects.toBeInstanceOf(RepositoryConflictError);
  });
});
