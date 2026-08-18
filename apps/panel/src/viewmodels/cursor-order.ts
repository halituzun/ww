// Opak imleç sıralaması (docs/08 WebSocket sözleşmesi).
//
// NEDEN AYRI: imleç 2^53'ü aşan bir UInt64'tür ve panel onu üç yerde
// karşılaştırıyor (sıralama, devam noktası, abonelik). Aynı BigInt mantığını
// üç kez kopyalamak, birinin ileride `Number`'a düşmesi demektir — kusurun
// ilk hâli tam olarak buydu.
export class CursorError extends Error {}

export function parseCursor(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    // Sessizce 0 saymak bozuk bir imleci "en baştan başla" gibi gösterir ve
    // akışı fark edilmeden yeniden oynatır.
    throw new CursorError(`geçersiz imleç: ${value}`);
  }
}

/**
 * İmleçleri SAYISAL karşılaştırır. Metinsel karşılaştırma "9" > "10" der —
 * bu depo aynı kusuru daha önce plan sürümlerinde yaşadı.
 */
export function compareCursors(left: string, right: string): number {
  const a = parseCursor(left);
  const b = parseCursor(right);
  return a === b ? 0 : (a < b ? -1 : 1);
}
