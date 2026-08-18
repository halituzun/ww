// Canlı besleme imleci — docs/08 WebSocket sözleşmesi ("cursor: string, opaque").
//
// NEDEN VAR: besleme `created_at ASC, seq ASC, event_id ASC` ile SIRALANIYOR
// ama `seq > afterSeq` ile SÜZÜLÜYORDU. Sıralama ölçütüyle süzme ölçütü aynı
// değilse sayfalama tutarsızdır.
//
// `seq` üstelik güvenilmezdir: her yazıcı onu başka ölçekte üretiyor. Canlı
// veride ölçtüm — kilitler 0-3, çoğu olay epoch-ms (~1.787e12), kurtarma ve
// commit ise hash (~1.15e18). Sonuç: tek bir hash olayı imleci 1e18'e fırlatır
// ve daha küçük seq'e sahip SONRAKİ HER OLAY sonsuza dek atlanır; seq'i 0 olan
// olaylar (tırmandırma, çalıştırma hatası) hiç teslim edilmez.
//
// İmleç bu yüzden sıralamanın kendisinden türetilir: (created_at, event_id).
// İstemci onu AYRIŞTIRMAZ, yalnız düz metin olarak karşılaştırır — bu yüzden
// kodlama sabit ayraçlıdır ve sözlük sırası zaman sırasıyla aynıdır.

/** Hiç olay görülmedi: her gerçek imleçten küçüktür. */
export const EMPTY_EVENT_CURSOR = '';

const SEPARATOR = '|';

export function encodeEventCursor(createdAt: string, eventId: string): string {
  return `${createdAt}${SEPARATOR}${eventId}`;
}

export function decodeEventCursor(
  cursor: string,
): { readonly createdAt: string; readonly eventId: string } | undefined {
  if (cursor === EMPTY_EVENT_CURSOR) return undefined;
  const index = cursor.indexOf(SEPARATOR);
  if (index <= 0 || index === cursor.length - 1) {
    // Bozuk imleci "baştan başla" saymak, akışı fark edilmeden yeniden
    // oynatır ve zaman çizelgesini çift kayıtla doldururdu.
    throw new Error(`gecersiz olay imleci: ${cursor}`);
  }
  return {
    createdAt: cursor.slice(0, index),
    eventId: cursor.slice(index + 1),
  };
}
