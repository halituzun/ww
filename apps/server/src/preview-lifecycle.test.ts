import { describe, expect, it } from 'vitest';
import { previewCrashed, previewMustStop } from './preview-lifecycle.js';

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

// docs/10: "süreç çökerse panelde rozet + tek tık yeniden başlatma."
// PreviewStatus çöküşü GÖSTERMİYORDU: süreç kendiliğinden ölünce
// `running: false` oluyordu — kullanıcının durdurmasıyla AYNI görünüm.
// Rozetin besleneceği sinyal yoktu.
describe('previewCrashed', () => {
  it('kayit varken ve surec olmusse cokme sayar', () => {
    expect(previewCrashed({ present: true, exitCode: 1 })).toBe(true);
    // Sinyalle öldürülmüş olabilir; çıkış kodu null ama sinyal varsa da çöküş.
    expect(previewCrashed({ present: true, exitCode: 0 })).toBe(true);
  });

  it('surec yasarken cokme saymaz', () => {
    expect(previewCrashed({ present: true, exitCode: null })).toBe(false);
  });

  // KULLANICI DURDURDUYSA kayıt silinir; kaydın yokluğu "çökmedi" demektir.
  // Bu ayrım olmadan her durdurma çöküş rozeti gösterirdi.
  it('kullanici durdurduysa cokme saymaz', () => {
    expect(previewCrashed({ present: false, exitCode: 0 })).toBe(false);
    expect(previewCrashed({ present: false, exitCode: null })).toBe(false);
  });
});
