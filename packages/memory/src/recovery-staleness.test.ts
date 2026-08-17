import { describe, expect, it } from 'vitest';
import { DEFAULT_RECOVERY_GRACE_MS, isRecoverableStale } from './recovery-staleness.js';

const base = { heartbeatMissing: true, lastUpdatedAtMs: 0, nowMs: 100_000, graceMs: 60_000 };

describe('isRecoverableStale', () => {
  it('heartbeat varsa asla kurtarmaz', () => {
    expect(isRecoverableStale({ ...base, heartbeatMissing: false })).toBe(false);
  });

  it('heartbeat yok ve pay dolduysa kurtarir', () => {
    expect(isRecoverableStale(base)).toBe(true);
  });

  // ASIL KUSUR: yeni atanmış agent henüz heartbeat yazmamıştır. Bunu ölü
  // saymak canlı görevi düşürüyor ve dosya kilidini çalıyordu.
  it('pay dolmadan kurtarmaz', () => {
    expect(isRecoverableStale({ ...base, nowMs: 30_000 })).toBe(false);
  });

  it('pay tam dolduğunda kurtarir', () => {
    expect(isRecoverableStale({ ...base, nowMs: 60_000 })).toBe(true);
  });

  // Yanlış kurtarma canlı işi öldürür; yapılmayan kurtarma yalnızca gecikir.
  // Şüphede kalınca kurtarma YAPILMAZ.
  it('bozuk zaman damgalarinda kurtarmaz', () => {
    expect(isRecoverableStale({ ...base, lastUpdatedAtMs: Number.NaN })).toBe(false);
    expect(isRecoverableStale({ ...base, nowMs: Number.NaN })).toBe(false);
    expect(isRecoverableStale({ ...base, graceMs: Number.NaN })).toBe(false);
    expect(isRecoverableStale({ ...base, graceMs: -1 })).toBe(false);
  });

  // Saat geriye giderse fark negatif olur; bu da "henüz erken" demektir.
  it('gelecekten gelen zaman damgasini kurtarmaz', () => {
    expect(isRecoverableStale({ ...base, lastUpdatedAtMs: 200_000 })).toBe(false);
  });

  it('varsayilan pay heartbeat TTL’inin iki kati', () => {
    expect(DEFAULT_RECOVERY_GRACE_MS).toBe(60_000);
  });
});
