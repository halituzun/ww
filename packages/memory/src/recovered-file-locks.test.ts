import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fileHashOf, plannedLockReleases } from './recovered-file-locks.js';

const NIL = '00000000-0000-0000-0000-000000000000';
const attempt = '11111111-1111-4111-8111-111111111111';

describe('fileHashOf', () => {
  // Executor kilidi aynı türetmeyle alır; farklı türetme yanlış anahtarı
  // bırakmaya çalışır ve kilit asla açılmaz.
  it('dosya yolunun SHA-1 ozetini uretir', () => {
    expect(fileHashOf('src/a.ts')).toBe(createHash('sha1').update('src/a.ts').digest('hex'));
  });
});

describe('plannedLockReleases', () => {
  it('her hedef dosya icin birakma planlar', () => {
    const plan = plannedLockReleases(['src/a.ts', 'src/b.ts'], attempt, NIL);
    expect(plan).toHaveLength(2);
    expect(plan[0]!.owner).toBe(attempt);
  });

  // Sahibi bilinmeyen kilidi bırakmak, çalışan başka bir işi soymak olurdu.
  it('sahipsiz denemede hicbir sey birakmaz', () => {
    expect(plannedLockReleases(['src/a.ts'], NIL, NIL)).toEqual([]);
    expect(plannedLockReleases(['src/a.ts'], '', NIL)).toEqual([]);
  });

  it('hedef dosya yoksa bos plan doner', () => {
    expect(plannedLockReleases([], attempt, NIL)).toEqual([]);
  });

  it('tekrarlanan yolu bir kez planlar', () => {
    expect(plannedLockReleases(['src/a.ts', 'src/a.ts'], attempt, NIL)).toHaveLength(1);
  });

  it('bos yollari atar', () => {
    expect(plannedLockReleases(['  ', 'src/a.ts'], attempt, NIL)).toHaveLength(1);
  });

  // Sıralı bırakma, iki kurtarmanın aynı anda ters sırada kilit dolaşıp
  // birbirini beklemesini (deadlock) engeller.
  it('anahtarlari kararli sirada uretir', () => {
    const first = plannedLockReleases(['src/b.ts', 'src/a.ts'], attempt, NIL);
    const second = plannedLockReleases(['src/a.ts', 'src/b.ts'], attempt, NIL);
    expect(first.map((r) => r.fileHash)).toEqual(second.map((r) => r.fileHash));
  });
});
