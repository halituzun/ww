import { afterEach, describe, expect, it } from 'vitest';
import { runtimeStatus } from './runtime-status.js';

const KEY = 'WW_PHASE8_RUNTIME_ENABLED';
const previous = process.env[KEY];

afterEach(() => {
  if (previous === undefined) delete process.env[KEY];
  else process.env[KEY] = previous;
});

describe('runtimeStatus', () => {
  it('bayrak yokken orkestrasyonu devre dışı bildirir', () => {
    delete process.env[KEY];
    const status = runtimeStatus(() => null);
    expect(status.orchestration).toBe('disabled');
    expect(status.reason).toMatch(/WW_PHASE8_RUNTIME_ENABLED/);
  });

  // Sessiz devre dışılık en tehlikelisi: server sağlıklı görünür ama görevler
  // sonsuza dek queued kalır. Sebep her zaman açıkça yazılmalı.
  it('devre dışıyken sebebi boş bırakmaz', () => {
    delete process.env[KEY];
    expect(runtimeStatus(() => null).reason.length).toBeGreaterThan(10);
  });

  it('bayrak açık ama kayıt yoksa yanlış yapılandırma bildirir', () => {
    process.env[KEY] = '1';
    const status = runtimeStatus(() => null);
    expect(status.orchestration).toBe('misconfigured');
    // Not: Türkçe ünsüz yumuşaması — 'kaydı' içinde 'kayıt' geçmez (t→d).
    expect(status.reason).toMatch(/kay(ıt|dı)/i);
  });

  it('bayrak açık ve kayıt varsa etkin bildirir', () => {
    process.env[KEY] = '1';
    const status = runtimeStatus(() => ({} as never));
    expect(status.orchestration).toBe('enabled');
    expect(status.reason).toBe('');
  });

  it('görevlerin işlenip işlenmeyeceğini açıkça söyler', () => {
    delete process.env[KEY];
    expect(runtimeStatus(() => null).tasksProcessed).toBe(false);
    process.env[KEY] = '1';
    expect(runtimeStatus(() => ({} as never)).tasksProcessed).toBe(true);
  });
});
