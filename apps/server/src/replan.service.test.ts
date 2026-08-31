import { describe, expect, it } from 'vitest';
import { parseReplanInput } from './replan.service.js';

describe('parseReplanInput', () => {
  it('sebep ve özeti kabul eder', () => {
    expect(parseReplanInput({ reason: 'kapsam değişti', summary: 'hamle kuralları eklendi' }))
      .toEqual({ reason: 'kapsam değişti', summary: 'hamle kuralları eklendi' });
  });

  // Sebepsiz revizyon planın NEDEN değiştiğini kayıt dışı bırakır.
  it('sebep zorunludur', () => {
    expect(() => parseReplanInput({ summary: 'x' })).toThrow();
  });

  it('boş sebebi reddeder', () => {
    expect(() => parseReplanInput({ reason: '   ', summary: 'x' })).toThrow();
  });

  it('boş özeti reddeder', () => {
    expect(() => parseReplanInput({ reason: 'x', summary: '  ' })).toThrow();
  });

  it('bilinmeyen alanı reddeder', () => {
    expect(() => parseReplanInput({ reason: 'x', summary: 'y', uydurma: 1 })).toThrow();
  });
});
