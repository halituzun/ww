import { describe, expect, it } from 'vitest';
import { toCursor } from './ws-cursor.js';

describe('WebSocket imleci (docs/08: "cursor: string — opaque")', () => {
  // KANITLANMIŞ CANLI KUSUR: `seq` UInt64'tür ve zarfa Number olarak
  // konuyordu. Canlı veritabanında en büyük seq 1.15e18 — 2^53'ün 128 katı.
  // 4393 olayın 2846'sı (%65) sınırın üstünde; kırpma sonrası geriye yalnız
  // 685 benzersiz değer kalıyor. Panel `seq` eşitliğiyle tekilleştirdiği için
  // gerisini ATIYOR: canlı besleme bağlı görünüp ölü kalıyordu.
  it('2^53 ustundeki seqi kayipsiz tasir', () => {
    const big = '1152376219910902321';
    expect(toCursor(big)).toBe(big);
    // Number'a çevirmek TAM DA kusurdur; kanıtı burada sabitliyoruz.
    expect(String(Number(big))).not.toBe(big);
  });

  it('birbirine cok yakin buyuk seqleri AYIRT eder', () => {
    expect(toCursor('1152376219910902321')).not.toBe(toCursor('1152376219910902322'));
  });


});
