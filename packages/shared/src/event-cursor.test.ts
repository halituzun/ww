import { describe, expect, it } from 'vitest';
import { decodeEventCursor, encodeEventCursor, EMPTY_EVENT_CURSOR } from './event-cursor.js';

const id = (n: number): string => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

describe('olay imleci (docs/08: opak, proje kapsamlı)', () => {
  it('kodlanan imlec cozulebilir', () => {
    const cursor = encodeEventCursor('2026-08-18 09:00:00.000', id(1));
    expect(decodeEventCursor(cursor)).toEqual({
      createdAt: '2026-08-18 09:00:00.000', eventId: id(1),
    });
  });

  // ASIL KUSUR: besleme ZAMANA göre sıralanıyor ama `seq`'e göre süzülüyordu.
  // `seq` her yazıcıda farklı ölçekte üretiliyor (kilitler 0-3, çoğu olay
  // epoch-ms, kurtarma/commit hash ~1e18). Tek bir hash olayı imleci 1e18'e
  // fırlatıyor ve sonraki HER olay sonsuza dek atlanıyordu.
  it('imlecler ZAMAN sirasina gore karsilastirilabilir', () => {
    const erken = encodeEventCursor('2026-08-18 09:00:00.000', id(9));
    const gec = encodeEventCursor('2026-08-18 09:00:01.000', id(1));
    // Düz metin karşılaştırması sıralamayı vermeli: imleç opaktır, istemci
    // onu ayrıştırmaz, yalnız karşılaştırır.
    expect(erken < gec).toBe(true);
  });

  it('ayni anda gelen olaylari kimlikle ayirir', () => {
    const a = encodeEventCursor('2026-08-18 09:00:00.000', id(1));
    const b = encodeEventCursor('2026-08-18 09:00:00.000', id(2));
    expect(a < b).toBe(true);
  });

  it('bos imlec her seyden kucuktur: bastan baslamak demektir', () => {
    expect(EMPTY_EVENT_CURSOR < encodeEventCursor('2026-08-18 09:00:00.000', id(1))).toBe(true);
    expect(decodeEventCursor(EMPTY_EVENT_CURSOR)).toBeUndefined();
  });

  it('bozuk imleci sessizce kabul etmez', () => {
    expect(() => decodeEventCursor('bozuk')).toThrow();
  });
});
