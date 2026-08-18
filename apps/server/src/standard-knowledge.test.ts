import { describe, expect, it, vi } from 'vitest';
import { STANDARD_RULE_IDS } from './standards-audit.js';
import {
  STANDARD_KNOWLEDGE, seedStandardKnowledge, seedStandardKnowledgeForProjects,
} from './standard-knowledge.js';

describe('standart bilgi tohumlaması', () => {
  // ASIL KUSUR (canlı veride ölçüldü, 2026-08-18): 78 proje, `knowledge`
  // tablosunda kind='standard' olan SIFIR satır. Context Builder'ın sabit
  // çekirdeği kod standartlarını oradan alır — yani hiçbir worker prompt'u
  // standartları içermiyordu. Sonra aynı sistem docs/09 denetçisini koşturup
  // o standartlardan ceza kesiyordu: prompt'ta hiç söylenmemiş bir kural.
  it('denetcinin her kurali icin bir standart girdisi vardir', () => {
    for (const ruleId of STANDARD_RULE_IDS) {
      const entry = STANDARD_KNOWLEDGE.find((row) => row.ruleId === ruleId);
      expect(entry, `${ruleId} icin standart girdisi yok`).toBeDefined();
      expect(entry!.content.length).toBeGreaterThan(40);
    }
  });

  it('proje icin kind=standard, status=active satirlar yazar', async () => {
    const append = vi.fn(async () => undefined);
    await seedStandardKnowledge(
      { appendKnowledgeVersion: append } as never,
      '11111111-1111-4111-8111-111111111111' as never,
      '2026-08-18T00:00:00.000Z',
    );

    expect(append).toHaveBeenCalledTimes(STANDARD_KNOWLEDGE.length);
    const rows = append.mock.calls.map((call) => call[0] as Record<string, unknown>);
    expect(rows.every((row) => row['kind'] === 'standard')).toBe(true);
    expect(rows.every((row) => row['status'] === 'active')).toBe(true);
    // Kimlik DETERMİNİSTİK: aynı proje için ikinci kez tohumlamak yeni satır
    // değil, aynı satırın aynı sürümüdür (appendKnowledgeVersion içerik
    // aynıysa mevcut satırı döndürür).
    expect(new Set(rows.map((row) => row['knowledge_id'])).size).toBe(rows.length);
  });

  it('ayni proje icin ayni kimlikleri uretir', async () => {
    const ids = async () => {
      const append = vi.fn(async () => undefined);
      await seedStandardKnowledge(
        { appendKnowledgeVersion: append } as never,
        '11111111-1111-4111-8111-111111111111' as never,
        '2026-08-18T00:00:00.000Z',
      );
      return append.mock.calls.map((call) => (call[0] as Record<string, unknown>)['knowledge_id']);
    };
    expect(await ids()).toEqual(await ids());
  });

  // Tohumlamayı yalnızca proje AÇILIŞINA bağlamak, hâlihazırda var olan 78
  // projeyi standartsız bırakırdı. Açılışta koşan projeler de tohumlanır;
  // işlem fikirsizce tekrarlanabilir (deterministik kimlik + içerik aynıysa
  // yeni sürüm yazılmaz).
  it('koşan projelerin tumunu tohumlar ve tek projenin hatasi digerlerini durdurmaz', async () => {
    const seen: string[] = [];
    const append = vi.fn(async (row: Record<string, unknown>) => {
      const projectId = String(row['project_id']);
      if (projectId.endsWith('2')) throw new Error('clickhouse down');
      seen.push(projectId);
      return undefined;
    });
    const failures: string[] = [];

    await seedStandardKnowledgeForProjects(
      { appendKnowledgeVersion: append } as never,
      [
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
        '33333333-3333-4333-8333-333333333333',
      ] as never,
      '2026-08-18T00:00:00.000Z',
      (projectId, reason) => failures.push(`${projectId}:${String(reason)}`),
    );

    expect(new Set(seen).size).toBe(2);
    // Hata SESSİZ kalmaz: standartsız koşan bir proje, denetçinin hiç
    // söylenmemiş kuraldan ceza kesmesi demektir.
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('clickhouse down');
  });
});
