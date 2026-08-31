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
  getPlanAsOf,
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

  const legacyRowHash = (row: PlanRow): string => canonicalSha256V1([
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

  function exactRaceClients(count: number): ClickHouseClient[] {
    let arrived = 0;
    let releaseBarrier = (): void => undefined;
    const barrier = new Promise<void>((resolve) => { releaseBarrier = resolve; });

    return Array.from({ length: count }, (_, index) => {
      let firstRead = true;
      return {
        query: async (options: Parameters<ClickHouseClient['query']>[0]) => {
          const result = await ch.query(options);
          if (firstRead) {
            firstRead = false;
            const captured = await result.json<unknown>();
            arrived += 1;
            if (arrived === count) releaseBarrier();
            await barrier;
            return { json: async () => captured };
          }
          return result;
        },
        command: async (options: Parameters<ClickHouseClient['command']>[0]) => {
          await new Promise((resolve) => setTimeout(resolve, index * 5));
          return ch.command(options);
        },
      } as unknown as ClickHouseClient;
    });
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

  it('observed_at kesitinde surum katlar, future kaydi reddeder ve late stale inserti yok sayar', async () => {
    const input = { ...plan(), created_at: '2099-01-01T00:00:00.000Z' };
    const initial = await createPlan(ch, input);
    const beforeInitial = new Date(Date.parse(initial.observed_at) - 1).toISOString();
    expect(await getPlanAsOf(ch, initial.project_id, initial.plan_id, beforeInitial)).toBeNull();
    expect((await getPlanAsOf(
      ch,
      initial.project_id,
      initial.plan_id,
      initial.observed_at,
    ))?.status).toBe('proposed');

    const approved = await appendPlanVersion(ch, {
      expectedVersion: initial.version,
      next: { ...initial, status: 'approved', approved_by: 'user' },
    });
    expect(Date.parse(approved.observed_at)).toBeGreaterThan(Date.parse(initial.observed_at));
    expect((await getPlanAsOf(
      ch,
      initial.project_id,
      initial.plan_id,
      initial.observed_at,
    ))?.version).toBe(initial.version);
    expect((await getPlanAsOf(
      ch,
      initial.project_id,
      initial.plan_id,
      approved.observed_at,
    ))?.version).toBe(approved.version);

    await ch.command({ query: 'OPTIMIZE TABLE plans FINAL' });
    const lateStale = {
      ...initial,
      observed_at: new Date(Date.parse(approved.observed_at) + 1).toISOString(),
    };
    await ch.insert({
      table: 'plans',
      values: [{
        ...lateStale,
        team_json: JSON.stringify(lateStale.team_json),
        scenarios_json: JSON.stringify(lateStale.scenarios_json),
        row_hash: rowHash(lateStale),
      }],
      format: 'JSONEachRow',
    });
    expect((await getLatestPlan(ch, initial.project_id, initial.plan_id))?.version)
      .toBe(approved.version);
    expect((await listLatestPlansByStatus(ch, initial.project_id, 'approved'))[0]?.version)
      .toBe(approved.version);
  });

  it('geciken ilk inserti caller saatiyle degil ClickHouse kabul zamaniyla keser', async () => {
    let releaseInsert = (): void => undefined;
    let markInsertReached = (): void => undefined;
    const insertGate = new Promise<void>((resolve) => { releaseInsert = resolve; });
    const insertReached = new Promise<void>((resolve) => { markInsertReached = resolve; });
    const delayedCh = {
      query: ch.query.bind(ch),
      command: async (options: Parameters<ClickHouseClient['command']>[0]) => {
        markInsertReached();
        await insertGate;
        return ch.command(options);
      },
    } as unknown as ClickHouseClient;

    const input = { ...plan(), created_at: '2020-01-01T00:00:00.000Z' };
    const pending = createPlan(delayedCh, input);
    await insertReached;
    const beforeAcceptance = new Date().toISOString();
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseInsert();
    const accepted = await pending;

    expect(Date.parse(accepted.observed_at)).toBeGreaterThan(Date.parse(beforeAcceptance));
    expect(await getPlanAsOf(
      ch,
      accepted.project_id,
      accepted.plan_id,
      beforeAcceptance,
    )).toBeNull();
  });

  it('12 concurrent exact create yokluk yarisi en erken MV kabul gozlemine katlanir', async () => {
    const input = plan();
    const created = await Promise.all(
      exactRaceClients(12).map((client) => createPlan(client, input)),
    );
    const observations = await ch.query({
      query: `SELECT count() AS count, uniqExact(observed_at) AS observed_count,
          toString(toUnixTimestamp64Milli(min(observed_at))) AS earliest_ms,
          toString(toUnixTimestamp64Milli(max(observed_at))) AS latest_ms
        FROM plan_acceptance_observations
        WHERE project_id = {projectId:UUID} AND plan_id = {planId:UUID}
          AND version = {version:UInt64} AND row_hash = {rowHash:String}`,
      query_params: {
        projectId: created[0]!.project_id,
        planId: created[0]!.plan_id,
        version: created[0]!.version,
        rowHash: rowHash(created[0]!),
      },
      format: 'JSONEachRow',
    });
    const [fold] = await observations.json<{
      count: string;
      observed_count: string;
      earliest_ms: string;
      latest_ms: string;
    }>();
    expect(fold?.count).toBe('12');
    expect(Number(fold?.observed_count)).toBeGreaterThan(1);
    const earliest = new Date(Number(fold?.earliest_ms)).toISOString();
    const afterAllAcceptances = new Date(Number(fold?.latest_ms) + 1).toISOString();
    expect(new Set(created.map((row) => row.observed_at))).toEqual(new Set([earliest]));
    expect(await getPlanAsOf(
      ch,
      input.project_id,
      input.plan_id,
      afterAllAcceptances,
    )).toMatchObject({
      plan_id: input.plan_id,
      version: created[0]!.version,
      observed_at: earliest,
    });

    await ch.command({ query: 'OPTIMIZE TABLE plans FINAL' });
    expect((await getLatestPlan(ch, input.project_id, input.plan_id))?.observed_at).toBe(earliest);
    expect(await getPlanAsOf(
      ch,
      input.project_id,
      input.plan_id,
      afterAllAcceptances,
    )).toMatchObject({
      plan_id: input.plan_id,
      version: created[0]!.version,
      observed_at: earliest,
    });
  }, 20_000);

  it('12 concurrent exact append yarisi OPTIMIZE sonrasi en erken kabul gozlemini korur', async () => {
    const initial = await createPlan(ch, plan());
    const appended = await Promise.all(exactRaceClients(12).map((client) => (
      appendPlanVersion(client, {
        expectedVersion: initial.version,
        next: { ...initial, status: 'approved', approved_by: 'user' },
      })
    )));
    const observations = await ch.query({
      query: `SELECT count() AS count, uniqExact(observed_at) AS observed_count,
          toString(toUnixTimestamp64Milli(min(observed_at))) AS earliest_ms,
          toString(toUnixTimestamp64Milli(max(observed_at))) AS latest_ms
        FROM plan_acceptance_observations
        WHERE project_id = {projectId:UUID} AND plan_id = {planId:UUID}
          AND version = {version:UInt64} AND row_hash = {rowHash:String}`,
      query_params: {
        projectId: initial.project_id,
        planId: initial.plan_id,
        version: appended[0]!.version,
        rowHash: rowHash(appended[0]!),
      },
      format: 'JSONEachRow',
    });
    const [fold] = await observations.json<{
      count: string;
      observed_count: string;
      earliest_ms: string;
      latest_ms: string;
    }>();
    expect(fold?.count).toBe('12');
    expect(Number(fold?.observed_count)).toBeGreaterThan(1);
    const earliest = new Date(Number(fold?.earliest_ms)).toISOString();
    const afterAllAcceptances = new Date(Number(fold?.latest_ms) + 1).toISOString();
    expect(new Set(appended.map((row) => row.observed_at))).toEqual(new Set([earliest]));
    expect(await getPlanAsOf(
      ch,
      initial.project_id,
      initial.plan_id,
      afterAllAcceptances,
    )).toMatchObject({
      plan_id: initial.plan_id,
      version: appended[0]!.version,
      status: 'approved',
      observed_at: earliest,
    });

    await ch.command({ query: 'OPTIMIZE TABLE plans FINAL' });
    const latest = await getLatestPlan(ch, initial.project_id, initial.plan_id);
    expect(latest).toMatchObject({
      version: appended[0]!.version,
      status: 'approved',
      observed_at: earliest,
    });
    expect(await getPlanAsOf(
      ch,
      initial.project_id,
      initial.plan_id,
      afterAllAcceptances,
    )).toMatchObject({
      plan_id: initial.plan_id,
      version: appended[0]!.version,
      status: 'approved',
      observed_at: earliest,
    });
  }, 20_000);

  it('legacy epoch observed_at ve eski row hashini created_at kesitine katlar', async () => {
    const input = plan();
    const logical: PlanRow = {
      ...input,
      observed_at: input.created_at,
      version: '1',
    };
    await ch.insert({
      table: 'plans',
      values: [{
        ...input,
        team_json: JSON.stringify(input.team_json),
        scenarios_json: JSON.stringify(input.scenarios_json),
        version: '1',
        row_hash: legacyRowHash(logical),
      }],
      format: 'JSONEachRow',
    });
    expect(await getPlanAsOf(
      ch,
      input.project_id,
      input.plan_id,
      new Date(Date.parse(input.created_at) - 1).toISOString(),
    )).toBeNull();
    expect((await getPlanAsOf(
      ch,
      input.project_id,
      input.plan_id,
      input.created_at,
    ))?.observed_at).toBe(input.created_at);
  });

  it('exact retry en erken kabul zamanini yeniden kullanir ve OPTIMIZE sonrasi korur', async () => {
    let retried = false;
    const retryingCh = {
      query: ch.query.bind(ch),
      command: async (options: Parameters<ClickHouseClient['command']>[0]) => {
        const first = await ch.command(options);
        if (!retried) {
          retried = true;
          await new Promise((resolve) => setTimeout(resolve, 5));
          await ch.command(options);
        }
        return first;
      },
    } as unknown as ClickHouseClient;
    const initial = await createPlan(retryingCh, plan());

    const observationsBeforeOptimize = await ch.query({
      query: `SELECT count() AS count, uniqExact(observed_at) AS observed_count,
          uniqExact(row_hash) AS hash_count, any(row_hash) AS stored_hash,
          toString(toUnixTimestamp64Milli(min(observed_at))) AS earliest_ms
        FROM plan_acceptance_observations
        WHERE project_id = {projectId:UUID} AND plan_id = {planId:UUID}
          AND version = {version:UInt64}`,
      query_params: {
        projectId: initial.project_id,
        planId: initial.plan_id,
        version: initial.version,
      },
      format: 'JSONEachRow',
    });
    const beforeOptimize = await observationsBeforeOptimize.json<{
      count: string;
      observed_count: string;
      hash_count: string;
      stored_hash: string;
      earliest_ms: string;
    }>();
    expect(beforeOptimize[0]?.count).toBe('2');
    expect(beforeOptimize[0]).toMatchObject({
      observed_count: '2',
      hash_count: '1',
      stored_hash: rowHash(initial),
      earliest_ms: String(Date.parse(initial.observed_at)),
    });

    await ch.command({ query: 'OPTIMIZE TABLE plans FINAL' });
    expect(await getLatestPlan(ch, initial.project_id, initial.plan_id)).toEqual(initial);
    expect(await getPlanAsOf(
      ch,
      initial.project_id,
      initial.plan_id,
      initial.observed_at,
    )).toEqual(initial);
    const physicalRowsAfterOptimize = await ch.query({
      query: `SELECT count() AS count FROM plans
        WHERE project_id = {projectId:UUID} AND plan_id = {planId:UUID}
          AND version = {version:UInt64}`,
      query_params: {
        projectId: initial.project_id,
        planId: initial.plan_id,
        version: initial.version,
      },
      format: 'JSONEachRow',
    });
    expect(await physicalRowsAfterOptimize.json()).toEqual([{ count: '1' }]);
    const observationsAfterOptimize = await ch.query({
      query: `SELECT count() AS count FROM plan_acceptance_observations
        WHERE project_id = {projectId:UUID} AND plan_id = {planId:UUID}
          AND version = {version:UInt64}`,
      query_params: {
        projectId: initial.project_id,
        planId: initial.plan_id,
        version: initial.version,
      },
      format: 'JSONEachRow',
    });
    expect(await observationsAfterOptimize.json()).toEqual([{ count: '2' }]);
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
