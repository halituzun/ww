// docs/09 Denetçi Kontrol Listeleri: "Denetçiler şu tetiklerle çalışır: her N
// görev tamamlanışında (varsayılan 5), her faz bitiminde, PM/kullanıcı
// istediğinde."
//
// NEDEN VAR: üç tetikten yalnız SONUNCUSU vardı. `auditFiles`'ı çağıran tek
// yer HTTP denetleyicisiydi, yani denetim ancak biri elle tetiklerse
// koşuyordu. Faz 4'ün "denetçiler en az bir bulgu üretip düzelttirir" adımı
// bu yüzden kendiliğinden hiç çalışmadı.

/** docs/09'un yazdığı varsayılan. */
export const DEFAULT_AUDIT_INTERVAL = 5;

const isPositiveInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value > 0;

/**
 * Bu tamamlanma denetimi tetikler mi?
 *
 * `completedCount` PROJEDEKİ toplam tamamlanmış görev sayısıdır.
 */
export function shouldRunStandardsAudit(
  completedCount: number,
  interval: number = DEFAULT_AUDIT_INTERVAL,
): boolean {
  // Sıfırıncı tamamlanma diye bir şey yok: saf modülo `0 % 5 === 0` deyip
  // hiç iş bitmeden denetim koşardı.
  if (!isPositiveInteger(completedCount)) return false;
  // Bozuk aralık denetimi SESSİZCE kapatmaz; varsayılana düşer.
  const step = isPositiveInteger(interval) ? interval : DEFAULT_AUDIT_INTERVAL;
  return completedCount % step === 0;
}
