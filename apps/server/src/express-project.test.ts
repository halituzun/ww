import { describe, expect, it } from 'vitest';
import { parseExpressProjectInput } from './orchestration.module.js';

describe('parseExpressProjectInput', () => {
  it('geçerli express proje girdisini doğru ayrıştırır', () => {
    const input = {
      name: 'Hava Durumu',
      prompt: 'Modern bir hava durumu ve tahmin web uygulaması',
      type: 'web',
    };
    const result = parseExpressProjectInput(input);
    expect(result.name).toBe('Hava Durumu');
    expect(result.prompt).toBe('Modern bir hava durumu ve tahmin web uygulaması');
    expect(result.type).toBe('web');
  });

  it('boş prompt veya isim verildiğinde hata fırlatır', () => {
    expect(() => parseExpressProjectInput({ name: '', prompt: 'uygulama' })).toThrow();
    expect(() => parseExpressProjectInput({ name: 'Proje', prompt: '' })).toThrow();
  });
});
