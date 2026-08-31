import { describe, expect, it, vi } from 'vitest';
import { loadSignal } from './workspace-signals.js';

describe('loadSignal', () => {
  it('basarili sonucu uygular', async () => {
    const apply = vi.fn();
    await loadSignal(async () => 42, apply, () => true, () => undefined);
    expect(apply).toHaveBeenCalledWith(42);
  });

  // REGRESYON KORUMASI: fetchBudgetReport ve fetchAuditReport artık hatayı
  // YUTMUYOR (bilinçli). Çağıran yakalamazsa panelde yakalanmamış promise
  // reddi oluşur ve bildirim sinyalleri sessizce durur.
  it('hatayi yakalar ve panele sizdirmaz', async () => {
    const apply = vi.fn();
    const onError = vi.fn();
    await expect(loadSignal(
      async () => { throw new Error('uç düştü'); },
      apply, () => true, onError,
    )).resolves.toBeUndefined();
    expect(apply).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  // Hata sonrası ESKİ değer korunur: sıfırlamak bildirimleri silerdi ve
  // "sorun yok" yalanını söylerdi.
  it('hatada mevcut degeri sifirlamaz', async () => {
    const apply = vi.fn();
    await loadSignal(async () => { throw new Error('x'); }, apply, () => true, () => undefined);
    expect(apply).not.toHaveBeenCalled();
  });

  it('bilesen kapandiysa uygulamaz', async () => {
    const apply = vi.fn();
    await loadSignal(async () => 1, apply, () => false, () => undefined);
    expect(apply).not.toHaveBeenCalled();
  });
});
