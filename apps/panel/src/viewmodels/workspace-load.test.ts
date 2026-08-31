import { describe, expect, it } from 'vitest';
import { describeLoadFailures } from './workspace-load.js';

describe('çalışma alanı yükleme sonuçları', () => {
  // ASIL KUSUR: `/usage`, `/provider-health` ve `/artifacts` hatayı YUTUYORDU.
  // Sağlayıcı sağlığı alınamadığında hiç rozet çizilmiyordu ve rozetin
  // YOKLUĞU kullanıcıya "her şey yolunda" diye okunuyordu — oysa docs/04
  // "düşen sağlayıcı panelde KIRMIZI görünür" diyor.
  //
  // Tek Promise.all ile hepsini reddettirmek de çözüm değil: bir uç düşünce
  // görevler ve dosyalar da güncellenmez, panel sessizce donardı.
  it('duşen yuzeyleri ADIYLA soyler', () => {
    expect(describeLoadFailures(['kontör', 'sağlayıcı sağlığı']))
      .toBe('Alınamadı: kontör, sağlayıcı sağlığı');
  });

  it('hepsi geldiyse mesaj uretmez', () => {
    expect(describeLoadFailures([])).toBe('');
  });
});
