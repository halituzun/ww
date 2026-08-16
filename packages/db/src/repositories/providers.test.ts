import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCh, type ClickHouseClient } from '../client.js';
import { runMigrations } from '../migrate.js';
import { clickhouseUp } from '../testutil.js';
import { listLatestApiProviders, upsertApiProvider } from './providers.js';

const up = await clickhouseUp();
describe.skipIf(!up)('api provider repository', () => {
  const db = `ww_test_providers_${Date.now()}_${process.pid}`;
  let ch: ClickHouseClient;
  beforeAll(async () => { await runMigrations({ database: db }); ch = createCh({ database: db }); });
  afterAll(async () => { const admin = createCh({ database: 'default' }); await admin.command({ query: `DROP DATABASE IF EXISTS ${db}` }); await admin.close(); await ch.close(); });

  it('provider konfigürasyonunu sürümler, idempotent tekrarlar ve anahtar referansını korur', async () => {
    const first = await upsertApiProvider(ch, { provider_id: 'mock', display_name: 'Mock', base_url: '', enabled: true, is_default: true, fallback_order: 0, models: ['mock-model'], key_ref: 'mock', health_status: 'unknown', last_health_check: '2026-08-16T00:00:00.000Z', updated_at: '2026-08-16T00:00:00.000Z' });
    const same = await upsertApiProvider(ch, { ...first, version: undefined } as never);
    expect(same.version).toBe(first.version);
    const changed = await upsertApiProvider(ch, { ...first, enabled: false, updated_at: '2026-08-16T00:01:00.000Z' });
    expect(BigInt(changed.version)).toBeGreaterThan(BigInt(first.version));
    expect((await listLatestApiProviders(ch)).map((row) => row.provider_id)).toEqual(['mock']);
    expect((await listLatestApiProviders(ch))[0]?.enabled).toBe(false);
  });
});
