import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCh, runMigrations, type ClickHouseClient } from '@ww/db';
import { buildCouncilTurnPrompt, loadCouncilPromptTemplates } from './council.service.js';

/**
 * Konsey promptlarının TABLODAKİ hâlini doğrular.
 *
 * NEDEN entegrasyon: promptlar artık kodda sabit string değil, migration 0012
 * ile `prompts` tablosunda. Metni bir test fixture'ına kopyalamak kaynağı
 * yeniden ikiye bölerdi; burada üretimin okuduğu satırlar denetlenir.
 */
const enabled = process.env['WW_REQUIRE_INTEGRATION'] === '1';
let probe: ClickHouseClient | undefined;
try {
  probe = createCh();
  await probe.query({ query: 'SELECT 1', format: 'JSONEachRow' });
} catch {
  if (enabled) throw new Error('ClickHouse entegrasyon servisi kapalı');
} finally {
  await probe?.close().catch(() => undefined);
  if (probe !== undefined) probe = createCh();
}

describe.skipIf(probe === undefined)('konsey promptları (tablo)', () => {
  let ch: ClickHouseClient;
  const database = `ww_test_council_prompts_${Date.now()}_${process.pid}`;

  beforeAll(async () => {
    await runMigrations({ database });
    ch = createCh({ database });
  });

  afterAll(async () => {
    await ch?.command({ query: `DROP DATABASE IF EXISTS ${database}` }).catch(() => undefined);
    await ch?.close().catch(() => undefined);
  });

  const prior = [
    {
      memberId: '11111111-1111-4111-8111-111111111111' as never,
      kind: 'draft_synthesis' as const,
      turnNumber: 3,
      turnTitle: 'Tur 3 · Birleşik Taslak',
      text: 'HTML5 oyun, offline önbellek ve canlı skor için seçenekler tartışılıyor.',
      evidenceRefs: [],
    },
    {
      memberId: '22222222-2222-4222-8222-222222222222' as never,
      kind: 'red_team' as const,
      turnNumber: 4,
      turnTitle: 'Tur 4 · Kırmızı Takım',
      text: 'Çevrimdışı çalışma ile canlı skor tablosu aynı anda mutlak garanti edilemez.',
      evidenceRefs: [],
    },
  ];

  it('tum tur promptlari tohumlanmis ve aktif', async () => {
    const templates = await loadCouncilPromptTemplates(ch);
    expect(templates.size).toBe(8);
    expect(templates.get('council.turn.envelope')).toContain('{{instruction}}');
  });

  // FAZ H'NİN KÖK NEDENİNİN MÜHÜRÜ: `draft_synthesis` yönergesi eval/regex,
  // özel parser/AST ve float kontrolünü PROJE-BAĞIMSIZ örnek olarak
  // dayatıyordu; model bu örneği bir OYUN projesinde de gerçek bulgu gibi
  // kopyalıyordu.
  it('oyun projesi promptlarina hesap makinesi ornegi gommez', async () => {
    const templates = await loadCouncilPromptTemplates(ch);
    const goal = 'Tamamen çevrimdışı çalışan VE canlı çok oyunculu küresel anlık skor tablosu olan web oyunu geliştir.';

    const redPrompt = buildCouncilTurnPrompt(templates, 'red_team', goal, prior.slice(0, 1));
    const finalPrompt = buildCouncilTurnPrompt(templates, 'final_synthesis', goal, prior);
    const birlesik = `${redPrompt}\n${finalPrompt}`;

    expect(birlesik).toContain('çevrimdışı');
    expect(birlesik).toContain('canlı');
    expect(birlesik).not.toMatch(/0\.1 \+ 0\.2|IEEE 754|eval\/regex|Matematik Motoru/i);
  });

  it('nihai sentez promptu DEPARTMANLAR ve GOREVLER bolumlerini zorunlu kilar', async () => {
    const templates = await loadCouncilPromptTemplates(ch);
    const prompt = buildCouncilTurnPrompt(templates, 'final_synthesis', 'hedef', prior);
    // Bu iki bölüm olmadan onay ne görev ne kadro üretebilir (Faz B2/B4).
    expect(prompt).toContain('## DEPARTMANLAR');
    expect(prompt).toContain('## GÖREVLER');
  });

  it('uye rolu sablonda yerine konur', async () => {
    const templates = await loadCouncilPromptTemplates(ch);
    const prompt = buildCouncilTurnPrompt(templates, 'proposal', 'hedef', [], 'Veri Lideri');
    expect(prompt).toContain('Veri Lideri');
    expect(prompt).not.toContain('{{member_role}}');
  });

  it('eksik prompt sessizce gecilmez', async () => {
    const eksik = new Map([['council.turn.envelope', '{{instruction}}']]);
    expect(() => buildCouncilTurnPrompt(eksik, 'proposal', 'hedef', []))
      .toThrow(/konsey promptu bulunamadi/);
  });
});
