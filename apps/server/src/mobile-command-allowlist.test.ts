import { describe, expect, it } from 'vitest';
import { assertMobileArgs, assertMobileCommand } from './mobile-command-allowlist.js';

describe('assertMobileCommand', () => {
  it('emulator ve adb komutlarına izin verir', () => {
    expect(assertMobileCommand('emulator')).toBe('emulator');
    expect(assertMobileCommand('adb')).toBe('adb');
  });

  // GÜVENLİK: beyaz liste olmadan bu yüzey rastgele komut çalıştırmaya döner.
  it('başka komutu reddeder', () => {
    expect(() => assertMobileCommand('rm')).toThrow(/çalıştıramaz/);
  });

  it('yol ekleyerek kaçmayı reddeder', () => {
    expect(() => assertMobileCommand('/usr/bin/adb')).toThrow(/çalıştıramaz/);
  });

  it('boş komutu reddeder', () => {
    expect(() => assertMobileCommand('')).toThrow(/çalıştıramaz/);
  });
});

describe('assertMobileArgs', () => {
  it('normal argümanlara izin verir', () => {
    expect(assertMobileArgs(['-list-avds'])).toEqual(['-list-avds']);
  });

  it('kabuk metakarakterini reddeder', () => {
    expect(() => assertMobileArgs(['x; rm -rf /'])).toThrow(/metakarakteri/);
  });

  it('boru karakterini reddeder', () => {
    expect(() => assertMobileArgs(['a | b'])).toThrow(/metakarakteri/);
  });

  it('NUL karakterini reddeder', () => {
    expect(() => assertMobileArgs(['a\0b'])).toThrow(/NUL/);
  });
});
