import { describe, expect, it, vi } from 'vitest';
import { HEARTBEAT_REFRESH_MS, withHeartbeat } from './work-heartbeat.js';

const ports = (over: Record<string, unknown> = {}) => ({
  beat: vi.fn(async () => undefined),
  setTimer: vi.fn(() => 1),
  clearTimer: vi.fn(),
  onError: vi.fn(),
  ...over,
}) as never as Parameters<typeof withHeartbeat>[0];

describe('withHeartbeat', () => {
  // ASIL KUSUR: heartbeat hiç yazılmıyordu; çalışan görev "ölü" görünüyor ve
  // süpürücü onun dosya kilidini devralıyordu.
  it('iş başlamadan önce canlılık işareti bırakır', async () => {
    const p = ports();
    await withHeartbeat(p, async () => 'ok');
    expect(p.beat).toHaveBeenCalled();
  });

  it('işin sonucunu döndürür', async () => {
    expect(await withHeartbeat(ports(), async () => 42)).toBe(42);
  });

  it('TTL’den kısa aralıkla yenileme kurar', async () => {
    const p = ports();
    await withHeartbeat(p, async () => 'ok');
    expect(p.setTimer).toHaveBeenCalledWith(expect.any(Function), HEARTBEAT_REFRESH_MS);
  });

  // Yenileme durdurulmazsa biten iş sonsuza dek "canlı" görünür.
  it('iş bitince yenilemeyi durdurur', async () => {
    const p = ports();
    await withHeartbeat(p, async () => 'ok');
    expect(p.clearTimer).toHaveBeenCalledWith(1);
  });

  it('iş hata verse de yenilemeyi durdurur', async () => {
    const p = ports();
    await expect(withHeartbeat(p, async () => { throw new Error('boom'); })).rejects.toThrow();
    expect(p.clearTimer).toHaveBeenCalledWith(1);
  });

  // Canlılık işareti kaybı en fazla kurtarmayı tetikler; işi iptal etmek daha kötü.
  it('heartbeat hatası işi düşürmez ama bildirilir', async () => {
    const onError = vi.fn();
    const p = ports({ onError, beat: async () => { throw new Error('redis düştü'); } });
    expect(await withHeartbeat(p, async () => 'ok')).toBe('ok');
    await new Promise((resolve) => setImmediate(resolve));
    expect(onError).toHaveBeenCalled();
  });
});
