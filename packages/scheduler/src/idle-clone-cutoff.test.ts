import { describe, expect, it } from 'vitest';
import { IDLE_CLONE_TTL_MS, idleCloneCutoff } from './idle-clone-cutoff.js';

describe('idleCloneCutoff (docs/03: "boşta kalan klonlar 10 dk sonra stopped")', () => {
  it('varsayilan omur 10 dakikadir', () => {
    expect(IDLE_CLONE_TTL_MS).toBe(10 * 60_000);
  });

  it('simdiden 10 dakika oncesini verir', () => {
    expect(idleCloneCutoff('2026-08-18T10:00:00.000Z'))
      .toBe('2026-08-18T09:50:00.000Z');
  });

  // Geçersiz saat sessizce "şimdi" sayılırsa HER klon durdurulur — az önce
  // açılmış olan bile. Süpürme, kendi girdisine güvenemediğinde HİÇBİR ŞEYİ
  // durdurmamalı.
  it('gecersiz saatte kesim noktasi uretmez', () => {
    expect(idleCloneCutoff('bozuk')).toBeUndefined();
    expect(idleCloneCutoff('')).toBeUndefined();
  });

  it('omur ayarlanabilir', () => {
    expect(idleCloneCutoff('2026-08-18T10:00:00.000Z', 60_000))
      .toBe('2026-08-18T09:59:00.000Z');
  });

  it('gecersiz omurde varsayilana duser', () => {
    expect(idleCloneCutoff('2026-08-18T10:00:00.000Z', -5))
      .toBe('2026-08-18T09:50:00.000Z');
  });
});
