import { describe, expect, it } from 'vitest';
import { deviceTapPoint } from './tap-coordinates.js';

// Görüntü panelde ÖLÇEKLENEREK gösterilir; tıklama noktası cihaz
// piksellerine çevrilmezse dokunuş yanlış yere gider. Bu, sessizce yanlış
// çalışan türden bir hatadır: bir şey olur, ama yanlış yerde.
const rect = { left: 100, top: 50, width: 320, height: 180 };
const natural = { width: 2560, height: 1440 };

describe('deviceTapPoint', () => {
  it('olceklenmis tiklamayi cihaz pikseline cevirir', () => {
    // Görüntünün tam ortası → cihazın tam ortası.
    expect(deviceTapPoint({ clientX: 260, clientY: 140 }, rect, natural))
      .toEqual({ x: 1280, y: 720 });
  });

  it('sol ust kose sifira dusler', () => {
    expect(deviceTapPoint({ clientX: 100, clientY: 50 }, rect, natural))
      .toEqual({ x: 0, y: 0 });
  });

  // Sınır dışına taşan tıklama KIRPILIR: negatif ya da ekran dışı koordinat
  // göndermek adb'de sessizce göz ardı edilir ve kullanıcı "dokunmadı"
  // sanır.
  it('sinir disini kirpar', () => {
    expect(deviceTapPoint({ clientX: 0, clientY: 0 }, rect, natural))
      .toEqual({ x: 0, y: 0 });
    expect(deviceTapPoint({ clientX: 9999, clientY: 9999 }, rect, natural))
      .toEqual({ x: 2559, y: 1439 });
  });

  // Görüntü daha yüklenmediyse doğal boyut 0'dır; 0'a bölmek NaN üretir ve
  // NaN koordinat adb'ye gönderilirse komut sessizce düşer.
  it('dogal boyut bilinmiyorsa nokta uretmez', () => {
    expect(deviceTapPoint({ clientX: 260, clientY: 140 }, rect, { width: 0, height: 0 }))
      .toBeUndefined();
  });

  it('gorunum boyutu sifirsa nokta uretmez', () => {
    expect(deviceTapPoint({ clientX: 1, clientY: 1 }, { left: 0, top: 0, width: 0, height: 0 }, natural))
      .toBeUndefined();
  });
});
