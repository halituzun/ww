import { describe, expect, it } from 'vitest';
import { VERIFIER_TOOLS, WORKER_TOOLS, resolveBriefPolicy } from './task-brief-policy.js';
import { STANDARD_KNOWLEDGE } from './standard-knowledge.js';

const task = (over: Partial<{ title: string; description: string; acceptance_criteria: string[] }> = {}) => ({
  project_id: '11111111-1111-4111-8111-111111111111',
  title: 'Satranç tahtası',
  description: '8x8 tahta çiz',
  acceptance_criteria: ['64 kare çizilir'],
  ...over,
});

describe('resolveBriefPolicy', () => {
  // ASIL KUSUR: allowedTools boştu; worker dosya yazamıyor, model çıktısı
  // metin olarak kalıyor ve hiçbir şey üretilmiyordu.
  it('worker’a dosya yazma araçlarını verir', () => {
    const allowed = resolveBriefPolicy(task(), []).allowedTools;
    for (const tool of WORKER_TOOLS) expect(allowed).toContain(tool);
  });

  // Verifier diff'i okuyamazsa doğrulama adımı hiç çalışamaz.
  it('verifier’ın diff aracını içerir', () => {
    const allowed = resolveBriefPolicy(task(), []).allowedTools;
    for (const tool of VERIFIER_TOOLS) expect(allowed).toContain(tool);
  });

  it('görevin kabul kriterlerini taşır', () => {
    expect(resolveBriefPolicy(task(), []).acceptanceCriteria).toEqual(['64 kare çizilir']);
  });

  // Kriter yoksa verifier neyi onaylayacağını bilemez; açıklamaya düşülür.
  it('kriter yoksa açıklamayı kriter yapar', () => {
    expect(resolveBriefPolicy(task({ acceptance_criteria: [] }), []).acceptanceCriteria)
      .toEqual(['8x8 tahta çiz']);
  });

  it('açıklama da yoksa başlığa düşer', () => {
    expect(resolveBriefPolicy(task({ acceptance_criteria: [], description: '  ' }), []).acceptanceCriteria)
      .toEqual(['Satranç tahtası']);
  });

  it('kural referanslarını olduğu gibi geçirir', () => {
    const rules = [{ id: 'r1' }];
    expect(resolveBriefPolicy(task(), rules).ruleRefs).toBe(rules);
  });

  it('mühürlenecek brief için proje standartlarının kimliklerini taşır', () => {
    const policy = resolveBriefPolicy(task(), []);
    expect(policy.standardKnowledgeIds).toHaveLength(STANDARD_KNOWLEDGE.length);
    expect(new Set(policy.standardKnowledgeIds).size).toBe(STANDARD_KNOWLEDGE.length);
  });

  it('aktif gereksinim kimliklerini brief politikasına taşır', () => {
    expect(resolveBriefPolicy(task(), [], ['req-1', 'req-2']).requirementKnowledgeIds)
      .toEqual(['req-1', 'req-2']);
  });

  // Worker raporunu report_result ile bitirir; araç izinli değilse görev
  // "kayıtlı olmayan araç" ile düşer ve iş asla teslim edilemez.
  it('worker’a iletişim araçlarını da verir', () => {
    const allowed = resolveBriefPolicy(task(), []).allowedTools;
    expect(allowed).toContain('report_result');
    expect(allowed).toContain('ask_question');
  });

  // Verifier salt-okuma sınırı tool-factory'de ayrıca uygulanır.
  it('worker’a komut çalıştırma vermez', () => {
    expect(resolveBriefPolicy(task(), []).allowedTools).not.toContain('run_command');
  });
});
