// Proje bütçe limitinin düzenlenmesi (docs/08 → Kontör Panosu: "bütçe
// düzenleme"; docs/07 → bütçe freni).
//
// NEDEN VAR: limit yalnızca proje OLUŞTURULURKEN verilebiliyordu. Sonradan
// değiştirmenin hiçbir yolu yoktu: varsayılan 0 (sınırsız) ile açılmış bir
// projeye belgelenen bütçe freni PANELDEN HİÇ kurulamıyordu.

export class BudgetLimitError extends Error {}

/**
 * Limit doğrulaması. Sıfır "sınırsız" demektir ve geçerlidir; negatif ya da
 * sayı olmayan değer sessizce sıfıra (sınırsız) çevrilmez — sessiz çevirim
 * kullanıcının koyduğunu sandığı freni yok ederdi.
 */
export function parseBudgetLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BudgetLimitError('bütçe limiti sayı olmalıdır');
  }
  if (value < 0) throw new BudgetLimitError('bütçe limiti negatif olamaz');
  if (value > 1_000_000) throw new BudgetLimitError('bütçe limiti çok yüksek');
  // Kuruş altı hassasiyet kontör panosunda anlamsızdır ve yuvarlama
  // farklarıyla "limit aşıldı mı" sorusunu belirsizleştirir.
  return Math.round(value * 10_000) / 10_000;
}

export interface BudgetLimitDecision {
  readonly limitUsd: number;
  /** Limit MEVCUT harcamanın altındaysa fren zaten tetiklenmiş demektir. */
  readonly alreadyExceeded: boolean;
}

export function decideBudgetLimit(value: unknown, spentUsd: number): BudgetLimitDecision {
  const limitUsd = parseBudgetLimit(value);
  const spent = Number.isFinite(spentUsd) && spentUsd > 0 ? spentUsd : 0;
  return Object.freeze({
    limitUsd,
    // Kullanıcı harcamanın altında bir limit koyabilir (kasıtlı durdurma),
    // ama bunun sonucu SÖYLENMELİDİR: yoksa projenin neden durduğunu aramak
    // zorunda kalır.
    alreadyExceeded: limitUsd > 0 && spent >= limitUsd,
  });
}
