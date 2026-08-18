import { describe, expect, it } from 'vitest';
import { mobileTargets } from './mobile-targets.js';

describe('mobileTargets (docs/10 → AVD tespiti)', () => {
  it('bagli cihazlari ve AVDleri birlikte doner', () => {
    expect(mobileTargets(['127.0.0.1:26624'], ['Pixel_8'])).toEqual({
      devices: ['127.0.0.1:26624'],
      avds: ['Pixel_8'],
      available: true,
    });
  });

  // BAĞLI CİHAZ varken emülatör ikilisi kurulu olmasa da önizleme MÜMKÜNDÜR.
  // Eskiden yalnız `listAvds` yayınlanıyordu ve o `emulator` ikilisini
  // çağırıyor; ikili yokken uç düşüyor ve panel "hiçbir şey yok" diyordu —
  // oysa iki gerçek cihaz bağlıydı.
  it('AVD listelenemese de bagli cihaz varsa kullanilabilir', () => {
    expect(mobileTargets(['127.0.0.1:26624'], [])).toMatchObject({ available: true });
  });

  it('cihaz da AVD de yoksa kullanilamaz', () => {
    expect(mobileTargets([], [])).toMatchObject({ available: false });
  });

  it('yinelenen hedefleri tekillestirir ve siralar', () => {
    expect(mobileTargets(['b', 'a', 'b'], ['y', 'x', 'y']))
      .toMatchObject({ devices: ['a', 'b'], avds: ['x', 'y'] });
  });
})
