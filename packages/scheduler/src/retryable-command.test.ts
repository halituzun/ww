import { describe, expect, it } from 'vitest';
import { isRetryableFailedCommand } from './retryable-command.js';

const row = (over: Partial<{ state: string; replay_safety: string }> = {}) => ({
  state: 'failed', replay_safety: 'replay_safe', ...over,
});

describe('isRetryableFailedCommand', () => {
  // ASIL KUSUR: kurtarmanın 'failed' yazdığı atama komutu, aynı deterministik
  // kimlikle gelen yeni denemeyi de sonsuza dek reddediyordu.
  it('replay-safe dusmus komut yeniden denenebilir', () => {
    expect(isRetryableFailedCommand(row())).toBe(true);
  });

  // Tekrarı güvenli olmayan komutu sessizce yeniden çalıştırmak, yan etkiyi
  // iki kez uygulamaktır: bu sınıf tırmandırılır, otomatik denenmez.
  it('non-replay-safe dusmus komut yeniden denenemez', () => {
    expect(isRetryableFailedCommand(row({ replay_safety: 'non_replay_safe' }))).toBe(false);
  });

  it('bilinmeyen replay-safety degerini guvenli tarafa koyar', () => {
    expect(isRetryableFailedCommand(row({ replay_safety: 'bilinmiyor' }))).toBe(false);
  });

  // Başarılı ya da hâlâ süren komuta dokunmak, biten işi geri alır ya da
  // yürüyen işi ikinci kez başlatır.
  it('failed olmayan durumlari yeniden denemez', () => {
    for (const state of ['pending', 'succeeded', 'uncertain']) {
      expect(isRetryableFailedCommand(row({ state }))).toBe(false);
    }
  });
});
