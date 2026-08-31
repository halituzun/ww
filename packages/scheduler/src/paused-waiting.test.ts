import { describe, expect, it } from 'vitest';
import { pausedWaitingMs } from './paused-waiting.js';

describe('pausedWaitingMs', () => {
  it('bekleme yoksa sifir doner', () => {
    expect(pausedWaitingMs([
      { status: 'queued', atMs: 0 },
      { status: 'working', atMs: 100 },
    ], 200)).toBe(0);
  });

  // ASIL KUSUR: bu aralık duvar saatine iş süresi olarak yazılıyordu.
  it('cevap beklenen araligi duraklama sayar', () => {
    expect(pausedWaitingMs([
      { status: 'working', atMs: 0 },
      { status: 'waiting_user', atMs: 100 },
      { status: 'working', atMs: 400 },
    ], 500)).toBe(300);
  });

  // Kullanıcı henüz cevap vermediyse bekleme ŞU ANA kadar sürer.
  it('hala bekleyen gorevde sureyi simdiye kadar sayar', () => {
    expect(pausedWaitingMs([
      { status: 'working', atMs: 0 },
      { status: 'waiting_user', atMs: 100 },
    ], 900)).toBe(800);
  });

  it('birden fazla bekleme turunu toplar', () => {
    expect(pausedWaitingMs([
      { status: 'waiting_user', atMs: 0 },
      { status: 'working', atMs: 50 },
      { status: 'waiting_user', atMs: 100 },
      { status: 'working', atMs: 250 },
    ], 300)).toBe(200);
  });

  it('awaiting_user durumunu da bekleme sayar', () => {
    expect(pausedWaitingMs([
      { status: 'awaiting_user', atMs: 0 },
      { status: 'working', atMs: 70 },
    ], 100)).toBe(70);
  });

  // Sürüm satırları ClickHouse'tan sıralı gelmeyebilir; sırasız girdi
  // aralıkları negatif yapıp duraklamayı yanlış hesaplardı.
  it('sirasiz noktalari sıraya koyar', () => {
    expect(pausedWaitingMs([
      { status: 'working', atMs: 400 },
      { status: 'waiting_user', atMs: 100 },
      { status: 'working', atMs: 0 },
    ], 500)).toBe(300);
  });

  // Eksik/bozuk ölçüm freni GEVŞETMEMELİDİR: sayılmayan bekleme en fazla
  // görevi erken durdurur; uydurulmuş bekleme freni tamamen kaldırırdı.
  it('bozuk zaman damgalarini yok sayar', () => {
    expect(pausedWaitingMs([
      { status: 'waiting_user', atMs: Number.NaN },
      { status: 'working', atMs: 100 },
    ], 200)).toBe(0);
  });

  it('gecersiz simdi degerinde sifir doner', () => {
    expect(pausedWaitingMs([{ status: 'waiting_user', atMs: 0 }], Number.NaN)).toBe(0);
  });

  it('bos gecmiste sifir doner', () => {
    expect(pausedWaitingMs([], 100)).toBe(0);
  });
});
