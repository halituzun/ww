import { describe, expect, it } from 'vitest';
import {
  MAX_RECONNECT_DELAY_MS,
  nextReconnectDelay,
  resumeCursor,
  connectionLabel,
} from './live-connection.js';
import type { TimelineEvent } from './workspace-logic.js';

const event = (seq: number): TimelineEvent => ({ event: 'task.updated', cursor: `2026-08-18 09:00:0${seq}.000|id`, ts: '', data: null });

describe('nextReconnectDelay', () => {
  it('ilk denemede kısa bekler', () => {
    expect(nextReconnectDelay(0)).toBeLessThanOrEqual(1000);
    expect(nextReconnectDelay(0)).toBeGreaterThan(0);
  });

  it('deneme arttıkça üstel büyür', () => {
    expect(nextReconnectDelay(1)).toBeGreaterThan(nextReconnectDelay(0));
    expect(nextReconnectDelay(3)).toBeGreaterThan(nextReconnectDelay(2));
  });

  // Sınırsız büyüme, sunucu geri geldiğinde paneli dakikalarca ölü bırakır.
  it('üst sınırı aşmaz', () => {
    expect(nextReconnectDelay(50)).toBe(MAX_RECONNECT_DELAY_MS);
  });

  it('geçersiz deneme sayısını güvenli sayar', () => {
    expect(nextReconnectDelay(-5)).toBeGreaterThan(0);
    expect(Number.isFinite(nextReconnectDelay(Number.NaN))).toBe(true);
  });
});

describe('resumeCursor', () => {
  // Yeniden bağlanmada 0'dan başlamak tüm geçmişi tekrar akıtır; görülen en
  // yüksek seq'ten devam etmek gerekir.
  it('görülen en yüksek imleç ile devam eder', () => {
    expect(resumeCursor([event(3), event(7), event(5)])).toBe('2026-08-18 09:00:07.000|id');
  });

  it('hiç olay yoksa baştan başlar', () => {
    // Boş imleç 'baştan başla' demektir.
    expect(resumeCursor([])).toBe('');
  });

  it('bos imlecleri yok sayar', () => {
    expect(resumeCursor([{ ...event(0), cursor: '' }, event(4)])).toBe('2026-08-18 09:00:04.000|id');
  });
});

describe('connectionLabel', () => {
  // Ölü bağlantı görünür olmalı: "bağlı görünüp donan panel" bu gecenin
  // en sinsi hata sınıfıydı.
  it('her durum için kullanıcıya okunur etiket verir', () => {
    expect(connectionLabel('connecting')).toMatch(/bağlan/i);
    expect(connectionLabel('open')).toMatch(/canlı/i);
    expect(connectionLabel('retrying')).toMatch(/yeniden/i);
    expect(connectionLabel('offline')).toMatch(/kesik|bağlantı yok/i);
  });

  it('etiketler boş değildir', () => {
    for (const state of ['connecting', 'open', 'retrying', 'offline'] as const) {
      expect(connectionLabel(state).length).toBeGreaterThan(0);
    }
  });
});
