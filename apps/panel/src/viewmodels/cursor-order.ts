// Opak imleç sıralaması (docs/08 WebSocket sözleşmesi).
//
// İmleç OPAKTIR: istemci onu AYRIŞTIRMAZ. Sunucu, sözlük sırası zaman sırasıyla
// aynı olacak şekilde kodlar; panelin tek yaptığı düz metin karşılaştırmasıdır.
//
// NEDEN AYRI: aynı karşılaştırma panelde üç yerde gerekiyor (sıralama, devam
// noktası, abonelik). Kopyalamak, birinin ileride yanlış türe düşmesi demekti —
// kusurun ilk hâli tam olarak buydu: imleç sayıya çevriliyor ve 2^53 üstünde
// kırpılıyordu.
export class CursorError extends Error {}

/** Hiç olay görülmedi; her gerçek imleçten küçüktür. */
export const EMPTY_CURSOR = '';

export function assertCursor(value: string): string {
  if (typeof value !== 'string') {
    // Sessizce boş saymak akışı fark edilmeden baştan oynatırdı.
    throw new CursorError(`geçersiz imleç: ${String(value)}`);
  }
  return value;
}

/** Sözlük sırası = zaman sırası (sunucu kodlaması bunu garanti eder). */
export function compareCursors(left: string, right: string): number {
  const a = assertCursor(left);
  const b = assertCursor(right);
  return a === b ? 0 : (a < b ? -1 : 1);
}

/** Görülen EN BÜYÜK imleç; devam noktası budur. */
export function highestCursor(values: readonly string[]): string {
  let highest = EMPTY_CURSOR;
  for (const value of values) {
    if (typeof value !== 'string' || value === '') continue;
    if (compareCursors(value, highest) > 0) highest = value;
  }
  return highest;
}
