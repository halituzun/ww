import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCh, type ClickHouseClient } from './client.js';
import { latest } from './latest.js';
import { runMigrations } from './migrate.js';
import { clickhouseUp } from './testutil.js';

const up = await clickhouseUp();

describe.skipIf(!up)('latest', () => {
  const db = `ww_test_latest_${Date.now()}`;
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

  it('iki sürümden yenisini döndürür', async () => {
    const id = randomUUID();
    const base = {
      project_id: id, slug: 's', type: 'web', status: 'draft',
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    await ch.insert({
      table: 'projects',
      values: [
        { ...base, name: 'eski', version: 1 },
        { ...base, name: 'yeni', version: 2 },
      ],
      format: 'JSONEachRow',
    });
    const rows = await latest<{ name: string }>(ch, 'projects', 'project_id', { project_id: id });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('yeni');
  });
});
