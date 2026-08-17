import { describe, expect, it, afterEach } from 'vitest';
import { phase8RuntimeFromEnvironment, phase9RuntimeFromConfig } from './runtime-composition.js';
import { readFile } from 'node:fs/promises';

describe('Phase 8 runtime configuration', () => {
  const previous = process.env['WW_PHASE8_RUNTIME_ENABLED'];
  afterEach(() => {
    if (previous === undefined) delete process.env['WW_PHASE8_RUNTIME_ENABLED'];
    else process.env['WW_PHASE8_RUNTIME_ENABLED'] = previous;
  });

  it('composition wiring yokken açıkça disabled kalır', () => {
    delete process.env['WW_PHASE8_RUNTIME_ENABLED'];
    expect(phase8RuntimeFromEnvironment()).toBeNull();
  });

  it('etkinleştirme eksik gerçek dependency wiring için fail-closed davranır', () => {
    process.env['WW_PHASE8_RUNTIME_ENABLED'] = '1';
    expect(() => phase8RuntimeFromEnvironment()).toThrow(/composition kayitli degil/);
  });

  it('AppModule config provider yokken Phase9 compositioni sessizce başlatmaz', () => {
    process.env['WW_PHASE8_RUNTIME_ENABLED'] = '1';
    expect(() => phase9RuntimeFromConfig(null)).toThrow(/Phase9RuntimeConfig/);
  });
});

describe('fren varsayılanı', () => {
  // docs/07 frenleri güvenlik sınırı sayar. Varsayılanın AÇIK olması bir
  // karardır: frensiz çalışmak bilinçli ve açıkça istenmelidir.
  it('kaynak, freni yalnız WW_DISABLE_BRAKES=1 ile devre dışı bırakır', async () => {
    const source = await readFile(
      new URL('./runtime-composition.ts', import.meta.url), 'utf8',
    );
    expect(source).toContain("process.env['WW_DISABLE_BRAKES'] === '1'");
    // Varsayılan dal guard'ı KURMALI; tersi sessiz bir güvenlik gerilemesidir.
    expect(source).toMatch(/WW_DISABLE_BRAKES'\] === '1'\s*\?\s*undefined\s*:\s*createBrakeGuard/);
  });
});
