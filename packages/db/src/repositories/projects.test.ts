import { randomUUID } from 'node:crypto';
import { NIL_UUID, canonicalSha256V1 } from '@ww/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCh, type ClickHouseClient } from '../client.js';
import { runMigrations } from '../migrate.js';
import { clickhouseUp } from '../testutil.js';
import {
  appendProjectVersion,
  createProject,
  getLatestProject,
  listLatestProjectsByStatus,
  type CreateProjectInput,
  type ProjectRow,
} from './projects.js';
import {
  RepositoryConflictError,
  RepositoryWriteError,
  StoredRecordError,
  type AcknowledgedWriteVerificationCause,
  type UncertainWriteCause,
} from './types.js';

const up = await clickhouseUp();

describe('projects uncertain write boundary', () => {
  it('insert ve reconciliation read birlikte hata verirse adapter hatasini typed olarak sarar', async () => {
    const insert = new Error('insert timeout');
    const reconciliation = new Error('reconciliation unavailable');
    let queryCount = 0;
    const client = {
      query: async () => {
        queryCount += 1;
        if (queryCount === 1) return { json: async () => [] };
        throw reconciliation;
      },
      insert: async () => { throw insert; },
    } as unknown as ClickHouseClient;

    await expect(createProject(client, {
      project_id: randomUUID(),
      name: 'WW',
      slug: 'ww-uncertain',
      type: 'api',
      status: 'draft',
      description: 'uncertain boundary',
      workspace_path: '/tmp/ww',
      budget_usd_limit: 20,
      settings: {},
      active_plan_id: NIL_UUID,
      created_at: '2026-08-14T00:00:00.000Z',
      updated_at: '2026-08-14T00:00:00.000Z',
    })).rejects.toSatisfy((error: unknown) => {
      if (!(error instanceof RepositoryWriteError)) return false;
      const cause = error.cause as UncertainWriteCause;
      return cause.insert === insert && cause.reconciliation === reconciliation;
    });
  });
});

describe.skipIf(!up)('projects repository', () => {
  const db = `ww_test_projects_${Date.now()}_${process.pid}`;
  let ch: ClickHouseClient;

  const rowHash = (row: ProjectRow): string => canonicalSha256V1([
    row.project_id, row.name, row.slug, row.type, row.status, row.description,
    row.workspace_path, row.budget_usd_limit, row.settings, row.active_plan_id,
    row.created_at, row.updated_at, row.version,
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

  function project(projectId = randomUUID(), status: CreateProjectInput['status'] = 'draft') {
    const now = new Date().toISOString();
    return {
      project_id: projectId,
      name: 'WW',
      slug: `ww-${projectId.slice(0, 8)}`,
      type: 'api',
      status,
      description: 'repository test',
      workspace_path: '/tmp/ww',
      budget_usd_limit: 20,
      settings: { max_parallel_agents: 4 },
      active_plan_id: NIL_UUID,
      created_at: now,
      updated_at: now,
    } satisfies CreateProjectInput;
  }

  it('create/getLatest/appendVersion ve stale-version sinirini uygular', async () => {
    const initial = await createProject(ch, project());
    expect((await getLatestProject(ch, initial.project_id))?.version).toBe(initial.version);

    const updated = await appendProjectVersion(ch, {
      expectedVersion: initial.version,
      next: { ...initial, status: 'running', updated_at: new Date().toISOString() },
    });
    expect(BigInt(updated.version)).toBeGreaterThan(BigInt(initial.version));
    expect((await getLatestProject(ch, initial.project_id))?.status).toBe('running');

    await expect(appendProjectVersion(ch, {
      expectedVersion: initial.version,
      next: { ...updated, status: 'paused' },
    })).rejects.toBeInstanceOf(RepositoryConflictError);
    await expect(createProject(ch, project(initial.project_id))).rejects.toBeInstanceOf(
      RepositoryConflictError,
    );
  });

  it('expectedVersion kanoniklestirir ve yalniz ileri katlanmis exact retryi kabul eder', async () => {
    const initial = await createProject(ch, project());
    const updated = await appendProjectVersion(ch, {
      expectedVersion: `000${initial.version}`,
      next: { ...initial, status: 'running', updated_at: '2026-08-14T00:01:00.000Z' },
    });
    await expect(appendProjectVersion(ch, {
      expectedVersion: (BigInt(updated.version) + 1n).toString(),
      next: { ...updated },
    })).rejects.toBeInstanceOf(RepositoryConflictError);
  });

  it('status filtresini surum katlamasindan sonra uygular', async () => {
    const oldRunning = await createProject(ch, project(randomUUID(), 'running'));
    await appendProjectVersion(ch, {
      expectedVersion: oldRunning.version,
      next: { ...oldRunning, status: 'archived', updated_at: new Date().toISOString() },
    });
    const currentRunning = await createProject(ch, project(randomUUID(), 'running'));

    const running = await listLatestProjectsByStatus(ch, 'running');
    expect(running.map((row) => row.project_id)).toContain(currentRunning.project_id);
    expect(running.map((row) => row.project_id)).not.toContain(oldRunning.project_id);
  });

  it('create ve append kabul sonrasi timeoutu exact surum reread ile uzlastirir', async () => {
    const uncertain = new Proxy(ch, {
      get(target, property) {
        if (property === 'insert') return async (options: Parameters<ClickHouseClient['insert']>[0]) => {
          await target.insert(options);
          throw new Error('simulated timeout after accept');
        };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const initial = await createProject(uncertain, project());
    const updated = await appendProjectVersion(uncertain, {
      expectedVersion: initial.version,
      next: { ...initial, status: 'running', updated_at: new Date().toISOString() },
    });
    expect((await getLatestProject(ch, initial.project_id))?.version).toBe(updated.version);
  });

  it('onaylanan insert sonrasi verification read hatasini typed verir ve exact create retry uzlasir', async () => {
    const input = project();
    const verification = new Error('simulated post-ack read failure');
    let failNextQuery = false;
    const acknowledged = new Proxy(ch, {
      get(target, property) {
        if (property === 'insert') return async (options: Parameters<ClickHouseClient['insert']>[0]) => {
          await target.insert(options);
          failNextQuery = true;
        };
        if (property === 'query') return (options: Parameters<ClickHouseClient['query']>[0]) => {
          if (failNextQuery) {
            failNextQuery = false;
            throw verification;
          }
          return target.query(options);
        };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const failure = await createProject(acknowledged, input).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RepositoryWriteError);
    const cause = (failure as RepositoryWriteError).cause as AcknowledgedWriteVerificationCause;
    expect(cause.commitLikely).toBe(true);
    expect(cause.verification).toBe(verification);
    expect(cause.operationIdentity).toMatch(/^[0-9a-f]{64}$/);

    const retried = await createProject(ch, input);
    expect(retried).toEqual(await getLatestProject(ch, input.project_id));

    const appendInput = {
      expectedVersion: retried.version,
      next: {
        ...retried,
        status: 'running' as const,
        updated_at: '2026-08-14T00:01:00.000Z',
      },
    };
    const appendFailure = await appendProjectVersion(acknowledged, appendInput)
      .catch((error: unknown) => error);
    expect(appendFailure).toBeInstanceOf(RepositoryWriteError);
    const appendRetried = await appendProjectVersion(ch, appendInput);
    expect(appendRetried).toEqual(await getLatestProject(ch, input.project_id));
  });

  it('max surum retry kopyasini katlar ve divergent tie kaydini fail-closed reddeder', async () => {
    const initial = await createProject(ch, project());
    const stored = {
      ...initial,
      settings: JSON.stringify(initial.settings),
      row_hash: rowHash(initial),
    };
    await ch.insert({ table: 'projects', values: [stored], format: 'JSONEachRow' });
    expect(await getLatestProject(ch, initial.project_id)).toEqual(initial);

    const divergent = { ...initial, name: 'divergent' };
    await ch.insert({
      table: 'projects',
      values: [{ ...stored, name: divergent.name, row_hash: rowHash(divergent) }],
      format: 'JSONEachRow',
    });
    await ch.command({ query: 'OPTIMIZE TABLE projects FINAL' });
    await expect(getLatestProject(ch, initial.project_id))
      .rejects.toBeInstanceOf(RepositoryConflictError);
    await expect(listLatestProjectsByStatus(ch, initial.status))
      .rejects.toBeInstanceOf(RepositoryConflictError);
  });

  it('concurrent divergent appendleri ayni deterministic surume yazar ve OPTIMIZE sonrasi reddeder', async () => {
    const initial = await createProject(ch, project());
    let capturedReads = 0;
    let releaseReads: (() => void) | undefined;
    const readGate = new Promise<void>((resolve) => { releaseReads = resolve; });
    const concurrent = new Proxy(ch, {
      get(target, property) {
        if (property === 'query') return async (options: Parameters<ClickHouseClient['query']>[0]) => {
          const result = await target.query(options);
          return new Proxy(result, {
            get(queryResult, queryProperty) {
              if (queryProperty !== 'json') {
                const value: unknown = Reflect.get(queryResult, queryProperty, queryResult);
                return typeof value === 'function' ? value.bind(queryResult) : value;
              }
              return async () => {
                const rows = await queryResult.json<unknown>();
                if (capturedReads < 2) {
                  capturedReads += 1;
                  if (capturedReads === 2) releaseReads?.();
                  await readGate;
                }
                return rows;
              };
            },
          });
        };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const [running, paused] = await Promise.allSettled([
      appendProjectVersion(concurrent, {
        expectedVersion: initial.version,
        next: { ...initial, status: 'running', updated_at: '2026-08-14T00:01:00.000Z' },
      }),
      appendProjectVersion(concurrent, {
        expectedVersion: initial.version,
        next: { ...initial, status: 'paused', updated_at: '2026-08-14T00:02:00.000Z' },
      }),
    ]);
    expect([running, paused].some((result) => (
      result.status === 'rejected' && result.reason instanceof RepositoryConflictError
    ))).toBe(true);

    await ch.command({ query: 'OPTIMIZE TABLE projects FINAL' });
    const versionsResult = await ch.query({
      query: `SELECT toString(version) AS version, count() AS count
        FROM projects WHERE project_id = {projectId:UUID}
        GROUP BY version ORDER BY version`,
      query_params: { projectId: initial.project_id },
      format: 'JSONEachRow',
    });
    expect(await versionsResult.json()).toEqual([
      { version: '1', count: '1' },
      { version: '2', count: '2' },
    ]);
    await expect(getLatestProject(ch, initial.project_id))
      .rejects.toBeInstanceOf(RepositoryConflictError);
  });

  it('bozuk kalici JSON kaydini domain satiri olarak sizdirmaz', async () => {
    const input = project();
    await ch.insert({
      table: 'projects',
      values: [{ ...input, settings: '{bad-json', version: '1' }],
      format: 'JSONEachRow',
    });
    await expect(getLatestProject(ch, input.project_id)).rejects.toBeInstanceOf(StoredRecordError);
  });
});
