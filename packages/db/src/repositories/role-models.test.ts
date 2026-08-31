import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCh, type ClickHouseClient } from '../client.js';
import { runMigrations } from '../migrate.js';
import { clickhouseUp } from '../testutil.js';
import { getLatestRoleModel, listLatestRoleModels, upsertRoleModel } from './role-models.js';

const up = await clickhouseUp();

describe.skipIf(!up)('role_models repository', () => {
  const db = `ww_test_rolemodels_${Date.now()}`;
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

  it('eşleme yazar ve son sürümü okur', async () => {
    const saved = await upsertRoleModel(ch, {
      role: 'worker',
      model_ref: 'deepseek:deepseek-chat',
      fallback_refs: ['openai:gpt-5-mini'],
      updated_at: new Date().toISOString(),
    });
    expect(saved.model_ref).toBe('deepseek:deepseek-chat');

    const read = await getLatestRoleModel(ch, 'worker');
    expect(read?.fallback_refs).toEqual(['openai:gpt-5-mini']);
  });

  it('güncellemede sürüm artar ve son değer kazanır', async () => {
    const first = await upsertRoleModel(ch, {
      role: 'verifier', model_ref: 'a:1', fallback_refs: [], updated_at: new Date().toISOString(),
    });
    const second = await upsertRoleModel(ch, {
      role: 'verifier', model_ref: 'b:2', fallback_refs: [], updated_at: new Date().toISOString(),
    });
    expect(BigInt(second.version)).toBeGreaterThan(BigInt(first.version));
    expect((await getLatestRoleModel(ch, 'verifier'))?.model_ref).toBe('b:2');
  });

  // Gereksiz sürüm şişmesi son-durum sorgularını yavaşlatır.
  it('içerik değişmediyse yeni sürüm yazmaz', async () => {
    const at = new Date().toISOString();
    const input = { role: 'pm', model_ref: 'x:1', fallback_refs: ['y:2'], updated_at: at };
    const first = await upsertRoleModel(ch, input);
    const again = await upsertRoleModel(ch, input);
    expect(again.version).toBe(first.version);
  });

  it('listede her rol tek satır döner', async () => {
    await upsertRoleModel(ch, {
      role: 'summarizer', model_ref: 'c:1', fallback_refs: [], updated_at: new Date().toISOString(),
    });
    await upsertRoleModel(ch, {
      role: 'summarizer', model_ref: 'c:2', fallback_refs: [], updated_at: new Date().toISOString(),
    });
    const rows = await listLatestRoleModels(ch);
    const summarizer = rows.filter((row) => row.role === 'summarizer');
    expect(summarizer).toHaveLength(1);
    expect(summarizer[0]!.model_ref).toBe('c:2');
  });

  it('bilinmeyen rol için null döner', async () => {
    expect(await getLatestRoleModel(ch, 'boyle-bir-rol-yok')).toBeNull();
  });

  it('tanımsız rolü ve bozuk model_ref biçimini reddeder', async () => {
    const at = new Date().toISOString();
    await expect(upsertRoleModel(ch, {
      role: 'uydurma_rol', model_ref: 'a:1', fallback_refs: [], updated_at: at,
    })).rejects.toThrow(/rol/i);

    // model_ref daima 'provider:model' biçimindedir (docs/04).
    await expect(upsertRoleModel(ch, {
      role: 'worker', model_ref: 'bicimsiz', fallback_refs: [], updated_at: at,
    })).rejects.toThrow(/model_ref/i);

    await expect(upsertRoleModel(ch, {
      role: 'worker', model_ref: 'a:1', fallback_refs: ['gecersiz'], updated_at: at,
    })).rejects.toThrow(/fallback/i);
  });
});
