import { describe, expect, it } from 'vitest';
import { previewMustStop } from './preview-lifecycle.js';

describe('previewMustStop (docs/10: "Proje duraklatılırsa/arşivlenirse süreçler kapatılır")', () => {
  it('duraklatilmis ve arsivlenmis projede durur', () => {
    expect(previewMustStop('paused')).toBe(true);
    expect(previewMustStop('archived')).toBe(true);
  });

  // Çalışan proje elbette durmaz; ama `draft`/`gathering`/`planning` de
  // durmaz: proje HENÜZ başlamamıştır, DURDURULMUŞ değildir. İkisini
  // karıştırmak, kullanıcının yeni projesinde önizlemeyi kapatırdı.
  it('calisan ve henuz baslamamis projelerde durmaz', () => {
    for (const status of ['running', 'draft', 'gathering', 'planning']) {
      expect(previewMustStop(status)).toBe(false);
    }
  });

  // `completed` bitmiş bir projedir; önizlemesi kapatılır (kaynak korunur)
  // ama bu docs/10'un saydığı iki durumdan ayrı bir karar olduğu için
  // AÇIKÇA test ediliyor.
  it('tamamlanmis projede durur', () => {
    expect(previewMustStop('completed')).toBe(true);
  });

  it('bilinmeyen durumda DURDURMAZ: bilgisizlik kapatma sebebi degildir', () => {
    expect(previewMustStop('')).toBe(false);
    expect(previewMustStop('bilinmeyen')).toBe(false);
  });
});
