import { describe, expect, it } from 'vitest';
import { applyResolution, parseResolutionInput } from './audit-resolution.service.js';

const taskId = '00000000-0000-4000-8000-000000000009';

describe('parseResolutionInput', () => {
  it('gerekçeli çözümü kabul eder', () => {
    expect(parseResolutionInput({ status: 'resolved', resolution: 'düzeltildi' }).status)
      .toBe('resolved');
  });

  // Gerekçesiz kapatma "neden kapandı" sorusunu cevapsız bırakır.
  it('gerekçesiz çözümü reddeder', () => {
    expect(() => parseResolutionInput({ status: 'resolved' })).toThrow(/gerekçe/);
  });

  it('gerekçesiz reddi de reddeder', () => {
    expect(() => parseResolutionInput({ status: 'dismissed' })).toThrow(/gerekçe/);
  });

  // Şema: düzeltme bekleyen bulgu düzeltme görevini göstermek zorunda.
  it('düzeltme görevi olmadan correction_pending kabul etmez', () => {
    expect(() => parseResolutionInput({ status: 'correction_pending' })).toThrow(/düzeltme görevi/);
  });

  it('düzeltme görevi verilince kabul eder', () => {
    expect(parseResolutionInput({ status: 'correction_pending', correctiveTaskId: taskId }).status)
      .toBe('correction_pending');
  });

  it('tekrar açmaya izin verir', () => {
    expect(parseResolutionInput({ status: 'open' }).status).toBe('open');
  });
});

describe('applyResolution', () => {
  const current = { findingId: 'f1', summary: 'ihlal', evidenceRefs: ['file:a'], status: 'open' };

  it('durumu günceller', () => {
    expect(applyResolution(current, parseResolutionInput({ status: 'resolved', resolution: 'ok' })).status)
      .toBe('resolved');
  });

  // Kanıt ve kimlik korunmazsa bulgu izlenebilirliğini kaybeder.
  it('kimliği ve kanıtı korur', () => {
    const next = applyResolution(current, parseResolutionInput({ status: 'resolved', resolution: 'ok' }));
    expect(next['findingId']).toBe('f1');
    expect(next['evidenceRefs']).toEqual(['file:a']);
  });

  it('gerekçeyi yazar', () => {
    const next = applyResolution(current, parseResolutionInput({ status: 'dismissed', resolution: 'yanlış pozitif' }));
    expect(next['resolution']).toBe('yanlış pozitif');
  });
});
