// Beklenmeyen efekt hatalarının YEREL gözlemi.
//
// NEDEN VAR: kalıcı kayıtlar KASITLI olarak sansürlüdür — sağlayıcı adı,
// anahtar, prompt ve istisna metni veritabanına yazılmaz. Doğru bir karar,
// ama sansür tek bilgi kaynağı olunca hata teşhis edilemez hale gelir:
// "INTERNAL_ERROR: beklenmeyen iletisim hatasi" operatöre hiçbir şey
// söylemez. Gözlemci ham hatayı YALNIZCA süreç içinde (log) verir;
// veritabanı sansürlü kalmaya devam eder.
export interface UnexpectedErrorContext {
  readonly effectType: string;
  readonly stableEffectId: string;
  readonly state: 'failed' | 'uncertain';
}

export type UnexpectedErrorObserver = (
  error: unknown,
  context: UnexpectedErrorContext,
) => void;

/** Gözlemcinin kendi hatası efekt yolunu ASLA bozmamalı. */
export function notifyUnexpectedError(
  observer: UnexpectedErrorObserver | undefined,
  error: unknown,
  context: UnexpectedErrorContext,
): void {
  if (observer === undefined) return;
  try {
    observer(error, context);
  } catch {
    // Teşhis kanalı, asıl hata yolunu kırmaktansa sessiz kalır.
  }
}
