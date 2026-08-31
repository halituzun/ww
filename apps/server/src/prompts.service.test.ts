import { describe, expect, it } from 'vitest';
import { nextPromptVersion, parseNewVersionInput } from './prompts.service.js';

const base = { content: 'Sen bir worker agentsın.', changelog: 'ilk sürüm' };

describe('parseNewVersionInput', () => {
  it('geçerli sürümü kabul eder', () => {
    expect(parseNewVersionInput(base).content).toBe(base.content);
  });

  // Değişiklik notu olmayan sürüm, "ne değişti" sorusunu cevapsız bırakır.
  it('changelog zorunludur', () => {
    expect(() => parseNewVersionInput({ content: 'x' })).toThrow();
  });

  it('boş içeriği reddeder', () => {
    expect(() => parseNewVersionInput({ ...base, content: '  ' })).toThrow();
  });

  // Yazmak ile canlıya almak ayrı kararlardır: bir düzenleme koşan işleri
  // anında etkilememeli.
  it('varsayılan olarak aktifleştirmez', () => {
    expect(parseNewVersionInput(base).activate).toBe(false);
  });

  it('istenirse aktifleştirmeyi taşır', () => {
    expect(parseNewVersionInput({ ...base, activate: true }).activate).toBe(true);
  });
});

describe('nextPromptVersion', () => {
  it('boş listede 1 döner', () => {
    expect(nextPromptVersion([])).toBe(1);
  });

  it('en büyüğün bir fazlasını döner', () => {
    expect(nextPromptVersion([{ prompt_version: 1 }, { prompt_version: 3 }])).toBe(4);
  });

  // Sıralama garanti değilse en büyüğü bulmak şarttır; son eleman yetmez.
  it('sırasız listede de doğru çalışır', () => {
    expect(nextPromptVersion([{ prompt_version: 5 }, { prompt_version: 2 }])).toBe(6);
  });
});
