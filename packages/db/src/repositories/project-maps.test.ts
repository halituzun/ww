import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalSha256V1 } from '@ww/shared';
import { createCh, type ClickHouseClient } from '../client.js';
import { runMigrations } from '../migrate.js';
import { clickhouseUp } from '../testutil.js';
import {
  createProjectMapSnapshot,
  getLatestProjectMapSnapshotAsOf,
  getLatestProjectMapSourceRefAsOf,
  getLatestProjectMapSnapshot,
  getProjectMapSourceRef,
  projectMapSourceHash,
} from './project-maps.js';

const up = await clickhouseUp();

describe.skipIf(!up)('project maps repository', () => {
  const db = `ww_test_project_maps_${Date.now()}_${process.pid}`;
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

  it('harita snapshotini kalıcı yazar ve manifest source ref üretir', async () => {
    const projectId = randomUUID();
    const projectMapId = randomUUID();
    const now = new Date().toISOString();
    const row = await createProjectMapSnapshot(ch, {
      project_map_id: projectMapId,
      project_id: projectId,
      map_json: {
        generatedAt: now,
        fileCount: 1,
        functionCount: 1,
        routeCount: 1,
        files: [{ filePath: 'src/api.controller.ts', layer: 'model' }],
      },
      file_count: 1,
      function_count: 1,
      route_count: 1,
      generated_at: now,
      created_at: now,
    });

    expect(await getLatestProjectMapSnapshot(ch, projectId)).toEqual(row);
    expect(projectMapSourceHash(row)).toBe(canonicalSha256V1(row));
    await expect(getProjectMapSourceRef(ch, projectId, projectMapId))
      .resolves.toEqual({
        sourceType: 'project_map',
        sourceId: projectMapId,
        version: 1,
        hash: projectMapSourceHash(row),
      });
    await expect(getLatestProjectMapSnapshotAsOf(ch, projectId, now))
      .resolves.toEqual(row);
    await expect(getLatestProjectMapSourceRefAsOf(ch, projectId, now))
      .resolves.toEqual({
        sourceType: 'project_map',
        sourceId: projectMapId,
        version: 1,
        hash: projectMapSourceHash(row),
      });
    await expect(getLatestProjectMapSnapshotAsOf(ch, projectId, '2020-01-01T00:00:00.000Z'))
      .resolves.toBeNull();
  });
});
