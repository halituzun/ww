// Dayanıklı deftere yazılacak değerin katı JSON'a normalleştirilmesi.
//
// NEDEN VAR: sağlayıcı sonucu `JsonValueSchema.parse` ile doğrulanır ve
// JSON'da `undefined` YOKTUR. Normalize edilmiş cevaptaki tek bir tanımsız
// alan (ör. content yokken) tüm efekti 'uncertain' yapıyor, non-replay-safe
// olduğu için tırmandırılıyor ve MODEL ÇAĞRISI HİÇ TAMAMLANMIYORDU.
//
// `undefined` anahtarları düşürmek JSON.stringify'ın yaptığının aynısıdır ve
// JSON anlambilimi açısından kayıpsızdır. JSON'da KARŞILIĞI OLMAYAN değerler
// (fonksiyon, symbol, bigint, NaN/Infinity) ise sessizce düşürülmez: kalıcı
// kayıtta sessiz veri kaybı, teşhis edilemez bir hata sınıfıdır.
export class StrictJsonError extends Error {
  constructor(path: string, detail: string) {
    super(`katı JSON'a çevrilemedi (${path === '' ? 'kök' : path}): ${detail}`);
    this.name = 'StrictJsonError';
  }
}

export function toStrictJson(value: unknown, path = ''): unknown {
  if (value === null) return null;

  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new StrictJsonError(path, `sonlu olmayan sayı: ${String(value)}`);
    }
    return value;
  }
  if (type === 'bigint') throw new StrictJsonError(path, 'bigint JSON değildir');
  if (type === 'function') throw new StrictJsonError(path, 'fonksiyon JSON değildir');
  if (type === 'symbol') throw new StrictJsonError(path, 'symbol JSON değildir');
  if (type === 'undefined') throw new StrictJsonError(path, 'undefined JSON değildir');

  if (Array.isArray(value)) {
    // Dizide undefined'ı düşürmek indeksleri kaydırır; JSON.stringify onu
    // null yapar ve biz de aynısını yaparız.
    return value.map((item, index) => (
      item === undefined ? null : toStrictJson(item, `${path}[${index}]`)
    ));
  }

  if (type === 'object') {
    const source = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      const entry = source[key];
      // JSON'da undefined anahtar yoktur; JSON.stringify de onu atar.
      if (entry === undefined) continue;
      output[key] = toStrictJson(entry, path === '' ? key : `${path}.${key}`);
    }
    return output;
  }

  throw new StrictJsonError(path, `desteklenmeyen tür: ${type}`);
}
