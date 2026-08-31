import { describe, expect, it } from 'vitest';
import { DEFAULT_PROVIDER_RPM, providerRequestsPerMinute } from './provider-rate.js';

describe('providerRequestsPerMinute', () => {
  it('ayar yokken sinirsizdir', () => {
    expect(providerRequestsPerMinute(undefined)).toBe(DEFAULT_PROVIDER_RPM);
    expect(providerRequestsPerMinute('')).toBe(0);
  });

  it('ayarlanan degeri kullanir', () => {
    expect(providerRequestsPerMinute('30')).toBe(30);
  });

  // Bozuk değer sessizce DARALTMAZ: koşan işi durdurmak, sınırsız bırakmaktan
  // daha kötü bir sürprizdir.
  it('bozuk degerde varsayilana duser', () => {
    for (const raw of ['abc', '-1', '1.5']) {
      expect(providerRequestsPerMinute(raw)).toBe(DEFAULT_PROVIDER_RPM);
    }
  });

  it('sifir acikca sinirsizdir', () => {
    expect(providerRequestsPerMinute('0')).toBe(0);
  });
});
