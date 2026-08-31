import { describe, expect, it } from 'vitest';
import { buildRequirementDocument } from './interview.service.js';

const questions = [
  { id: 'goal', prompt: 'Bu projenin ana hedefi nedir?' },
  { id: 'users', prompt: 'Kimler kullanacak?' },
  { id: 'constraints', prompt: 'Teknik veya zaman kısıtları var mı?' },
];

describe('buildRequirementDocument', () => {
  it('cevaplari sorularla birlikte okunabilir sekilde yazar', () => {
    const doc = buildRequirementDocument('Yapılacaklar', questions, {
      goal: 'Görev takibi', users: 'Tek kullanıcı',
    });

    expect(doc).toContain('# Yapılacaklar — gereksinimler');
    expect(doc).toContain('Bu projenin ana hedefi nedir?');
    expect(doc).toContain('Görev takibi');
  });

  // Cevaplanmayan isteğe bağlı soruyu boş başlıkla yazmak, dokümanı
  // "soruldu ama cevapsız" gibi değil, eksik gibi gösterirdi.
  it('cevaplanmayan soruyu dokumana koymaz', () => {
    const doc = buildRequirementDocument('X', questions, { goal: 'A', users: 'B' });
    expect(doc).not.toContain('Teknik veya zaman kısıtları');
  });

  it('soru sirasini korur', () => {
    const doc = buildRequirementDocument('X', questions, { goal: 'A', users: 'B' });
    expect(doc.indexOf('ana hedefi')).toBeLessThan(doc.indexOf('Kimler kullanacak'));
  });

  it('hic cevap yoksa yalnizca basligi yazar', () => {
    expect(buildRequirementDocument('X', questions, {}).trim()).toBe('# X — gereksinimler');
  });
});
