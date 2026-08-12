import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCh } from './client.js';
import { runMigrations } from './migrate.js';
import { clickhouseUp } from './testutil.js';

const up = await clickhouseUp();

describe.skipIf(!up)('runMigrations', () => {
  const db = `ww_test_${Date.now()}`;
  const admin = createCh({ database: 'default' });

  beforeAll(async () => {
    await admin.command({ query: `CREATE DATABASE ${db}` });
  });
  afterAll(async () => {
    await admin.command({ query: `DROP DATABASE IF EXISTS ${db}` });
    await admin.close();
  });

  it('uygular, ikinci koşu no-op, checksum bozulunca hata verir', async () => {
    const a = await runMigrations({ database: db });
    expect(a.applied.length).toBeGreaterThan(0);

    const b = await runMigrations({ database: db });
    expect(b.applied).toHaveLength(0); // idempotent

    const first = a.applied[0]!;
    await expect(
      runMigrations({ database: db, files: [{ name: first, sql: 'SELECT 2;' }] }),
    ).rejects.toThrow(/checksum/i);
  });

  it('şemadaki çekirdek tablolar oluşur', async () => {
    const ch = createCh({ database: db });
    const rs = await ch.query({ query: 'SHOW TABLES', format: 'JSONEachRow' });
    const names = (await rs.json<{ name: string }>()).map((r) => r.name);
    for (const t of ['projects', 'agents', 'plans', 'tasks', 'messages', 'events',
      'artifacts', 'file_index', 'knowledge', 'summaries', 'embeddings', 'prompts',
      'api_providers', 'role_models', 'api_usage', 'mv_usage_daily', 'mv_provider_errors']) {
      expect(names, `tablo eksik: ${t}`).toContain(t);
    }
    await ch.close();
  });
});
