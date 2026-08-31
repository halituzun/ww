import { describe, expect, it } from 'vitest';
import { selectVerdictCall } from './verdict-selection.js';

const verdict = (decision: string) => ({ name: 'submit_verdict', args: { verdict: { decision } } });

describe('selectVerdictCall', () => {
  it('tek verdikti döner', () => {
    expect(selectVerdictCall([verdict('approve')]).args).toEqual({ verdict: { decision: 'approve' } });
  });

  // ASIL KUSUR: model submit_verdict'i birden çok kez çağırabiliyor ve
  // "tam olarak bir çağrı" kuralı doğrulamayı tamamen düşürüyordu.
  it('aynı içerikli tekrarları hoş görür', () => {
    expect(selectVerdictCall([verdict('approve'), verdict('approve')]).name).toBe('submit_verdict');
  });

  // Belirsizlik sessizce çözülmez: birini seçmek uydurma olurdu.
  it('çelişkili verdiktleri reddeder', () => {
    expect(() => selectVerdictCall([verdict('approve'), verdict('reject')]))
      .toThrow(/çelişkili/);
  });

  it('hiç verdikt yoksa açık hata verir', () => {
    expect(() => selectVerdictCall([])).toThrow(/çağırmadı/);
  });

  // Verifier salt-okumadır; başka araç çağırması sözleşme ihlalidir.
  it('başka araç çağrısı varsa reddeder', () => {
    expect(() => selectVerdictCall([verdict('approve'), { name: 'write_file', args: {} }]))
      .toThrow(/yalnız submit_verdict/);
  });
});
