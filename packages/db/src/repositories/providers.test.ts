import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCh, type ClickHouseClient } from '../client.js';
import { runMigrations } from '../migrate.js';
import { clickhouseUp } from '../testutil.js';
import { listLatestApiProviders, recordApiProviderHealth, upsertApiProvider } from './providers.js';

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

  // ASIL KUSUR: periyodik sağlık taraması satırın TAMAMINI yazıyordu ve
  // yazdığı alanlar taramanın BAŞINDA okunmuş anlık görüntüden geliyordu.
  // Ping saniyeler sürdüğü için, o aralıkta kullanıcının panelden yaptığı
  // değişiklik (sağlayıcıyı pasifleştirme, YENİ ANAHTAR girme) sağlık
  // yazımıyla sessizce geri alınabiliyordu. "Girdiğim anahtar çalışmıyor"
  // gibi görünen, aslında kaybolmuş bir yazma.
  it('saglik yazimi kullanicinin degistirdigi alanlari geri almaz', async () => {
    const at = '2026-08-18T00:00:00.000Z';
    await upsertApiProvider(ch, {
      provider_id: 'kilit', display_name: 'Kilit', base_url: 'https://x', enabled: true,
      is_default: false, fallback_order: 1, models: ['m'], key_ref: 'eski-anahtar',
      health_status: 'unknown', last_health_check: at, updated_at: at,
    });

    // Tarama sağlayıcıyı okudu (anlık görüntü) ve ping'e gitti...
    const snapshot = (await listLatestApiProviders(ch)).find((row) => row.provider_id === 'kilit')!;

    // ...bu sırada kullanıcı anahtarı değiştirdi ve sağlayıcıyı pasifleştirdi.
    await upsertApiProvider(ch, {
      ...snapshot, enabled: false, key_ref: 'yeni-anahtar',
      updated_at: '2026-08-18T00:00:05.000Z',
    });

    // ...ping döndü ve sağlık yazıldı.
    await recordApiProviderHealth(ch, {
      provider_id: 'kilit', health_status: 'ok', last_health_check: '2026-08-18T00:00:06.000Z',
    });

    const latest = (await listLatestApiProviders(ch)).find((row) => row.provider_id === 'kilit')!;
    expect(latest.health_status).toBe('ok');
    // Kullanıcının yazdıkları AYAKTA kalmalı.
    expect(latest.enabled).toBe(false);
    expect(latest.key_ref).toBe('yeni-anahtar');
  });

  it('olmayan saglayici icin null doner, patlamaz', async () => {
    await expect(recordApiProviderHealth(ch, {
      provider_id: 'yok-boyle-biri', health_status: 'ok',
      last_health_check: '2026-08-18T00:00:00.000Z',
    })).resolves.toBeNull();
  });
});
