import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clickhouseUp, createCh, runMigrations, upsertApiProvider, upsertRoleModel, type ClickHouseClient } from '@ww/db';
import { loadRoutingIndex } from './routing.loader.js';

const up = await clickhouseUp();

describe.skipIf(!up)('loadRoutingIndex', () => {
  const db = `ww_test_routing_${Date.now()}`;
  let ch: ClickHouseClient;

  beforeAll(async () => {
    await runMigrations({ database: db });
    ch = createCh({ database: db });
    const at = new Date().toISOString();

    await upsertApiProvider(ch, {
      provider_id: 'deepseek', display_name: 'DeepSeek', base_url: '', enabled: true,
      is_default: false, fallback_order: 1, models: ['deepseek-chat'], key_ref: 'deepseek',
      health_status: 'ok', last_health_check: at, updated_at: at,
    });
    await upsertApiProvider(ch, {
      provider_id: 'openai', display_name: 'OpenAI', base_url: '', enabled: true,
      is_default: true, fallback_order: 0, models: ['gpt-5-mini'], key_ref: 'openai',
      health_status: 'ok', last_health_check: at, updated_at: at,
    });
    await upsertApiProvider(ch, {
      provider_id: 'kapali', display_name: 'Kapalı', base_url: '', enabled: false,
      is_default: false, fallback_order: 9, models: ['x'], key_ref: '',
      health_status: 'down', last_health_check: at, updated_at: at,
    });

    await upsertRoleModel(ch, {
      role: 'worker', model_ref: 'deepseek:deepseek-chat',
      fallback_refs: ['kapali:x'], updated_at: at,
    });
  });

  afterAll(async () => {
    const admin = createCh({ database: 'default' });
    await admin.command({ query: `DROP DATABASE IF EXISTS ${db}` });
    await admin.close();
    await ch.close();
  });

  it('rolü DB kaydındaki eşlemeye göre çözer', async () => {
    const index = await loadRoutingIndex(ch);
    expect(index.modelForRole('worker')).toBe('deepseek:deepseek-chat');
  });

  it('pasif sağlayıcıya ait yedeği eler, varsayılanı son durak yapar', async () => {
    const index = await loadRoutingIndex(ch);
    const chain = index.fallbacks('deepseek:deepseek-chat');
    expect(chain).not.toContain('kapali:x');
    expect(chain).toEqual(['openai:gpt-5-mini']);
  });

  it('eşlenmemiş rol için undefined döner', async () => {
    const index = await loadRoutingIndex(ch);
    expect(index.modelForRole('professor')).toBeUndefined();
  });
});
