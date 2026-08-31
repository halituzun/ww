import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCh, type ClickHouseClient } from '../client.js';
import { runMigrations } from '../migrate.js';
import { clickhouseUp } from '../testutil.js';
import { appendArtifact, getArtifact, listTaskArtifacts, type ArtifactRow } from './artifacts.js';

const up = await clickhouseUp();
describe.skipIf(!up)('artifacts repository', () => {
  const db = `ww_test_artifacts_${Date.now()}_${process.pid}`;
  let ch: ClickHouseClient;
  beforeAll(async () => { await runMigrations({ database: db }); ch = createCh({ database: db }); });
  afterAll(async () => {
    const admin = createCh({ database: 'default' });
    await admin.command({ query: `DROP DATABASE IF EXISTS ${db}` });
    await admin.close(); await ch.close();
  });

  it('append-only artifacti idempotent okur ve retry duplicateini listede katlar', async () => {
    const row: ArtifactRow = {
      artifact_id: randomUUID(), project_id: randomUUID(), task_id: randomUUID(),
      agent_id: randomUUID(), artifact_type: 'repository', name: 'BriefRepository',
      path: 'packages/db/src/repositories/briefs.ts', summary: 'Immutable contracts',
      commit_hash: 'abcdef1', created_at: new Date().toISOString(),
    };
    expect(await appendArtifact(ch, row)).toEqual(row);
    await ch.insert({ table: 'artifacts', values: [row], format: 'JSONEachRow' });
    expect(await getArtifact(ch, row.artifact_id)).toEqual(row);
    expect(await listTaskArtifacts(ch, row.project_id, row.task_id)).toEqual([row]);
  });

  it('fiziksel retry kopyalari mantiksal liste limitini tuketmez', async () => {
    const projectId = randomUUID();
    const taskId = randomUUID();
    const first: ArtifactRow = {
      artifact_id: randomUUID(), project_id: projectId, task_id: taskId,
      agent_id: randomUUID(), artifact_type: 'repository', name: 'First',
      path: 'first.ts', summary: 'first', commit_hash: 'abcdef1',
      created_at: '2090-01-01T00:00:00.000Z',
    };
    const second: ArtifactRow = {
      ...first,
      artifact_id: randomUUID(),
      name: 'Second',
      path: 'second.ts',
      created_at: '2090-01-01T00:00:01.000Z',
    };
    await appendArtifact(ch, first);
    await appendArtifact(ch, second);
    await ch.insert({ table: 'artifacts', values: [first], format: 'JSONEachRow' });

    expect((await listTaskArtifacts(ch, projectId, taskId, 2)).map((row) => row.artifact_id))
      .toEqual([first.artifact_id, second.artifact_id]);
  });
});
