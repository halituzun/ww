import { describe, expect, it } from 'vitest';
import { normalizeVerdictArguments } from './verdict-normalize.js';

describe('normalizeVerdictArguments', () => {
  // ASIL KUSUR: model evidenceRefs'e boş dize koyunca şema tüm verdikti
  // reddediyor ve doğrulama adımı hiç tamamlanamıyordu.
  it('boş kanıt referanslarını ayıklar', () => {
    expect(normalizeVerdictArguments({ evidenceRefs: ['file:a.ts', '', '  '] }))
      .toEqual({ evidenceRefs: ['file:a.ts'] });
  });

  it('iç içe listelerde de ayıklar', () => {
    expect(normalizeVerdictArguments({ reasons: [{ evidenceRefs: ['', 'x'] }] }))
      .toEqual({ reasons: [{ evidenceRefs: ['x'] }] });
  });

  // Bilgi taşıyan hiçbir alan değişmemeli.
  it('dolu değerleri korur', () => {
    const input = { decision: 'approve', reasons: [{ ruleId: 'R1', evidenceRefs: ['a'] }] };
    expect(normalizeVerdictArguments(input)).toEqual(input);
  });

  it('boş olmayan metinleri kırpmaz', () => {
    expect(normalizeVerdictArguments({ summary: '  boşluklu  ' }))
      .toEqual({ summary: '  boşluklu  ' });
  });

  it('null ve sayıları korur', () => {
    expect(normalizeVerdictArguments({ a: null, b: 3 })).toEqual({ a: null, b: 3 });
  });

  it('tamamen boş liste boş kalır', () => {
    expect(normalizeVerdictArguments({ evidenceRefs: ['', ''] })).toEqual({ evidenceRefs: [] });
  });
});
