// Bildirim sinyallerinin yüklenmesi (docs/08 → bildirim merkezi kaynakları).
//
// NEDEN VAR: `fetchBudgetReport` ve `fetchAuditReport` artık hatayı YUTMUYOR
// (bilinçli: "veri gelmedi" ile "sorun yok" aynı şey değildir). Ama çağıran
// yakalamazsa panelde YAKALANMAMIŞ PROMISE REDDİ oluşur ve bildirim
// sinyalleri sessizce durur — düzeltilen yalanın yerine yenisi geçer.

/**
 * Sinyali yükler; hata panele sızmaz.
 *
 * Hatada MEVCUT DEĞER KORUNUR: sıfırlamak bildirimleri siler ve "sorun yok"
 * yalanını söyler. Bilinen son durum, bilinmeyen bir durumdan iyidir.
 */
export async function loadSignal<T>(
  load: () => Promise<T>,
  apply: (value: T) => void,
  isActive: () => boolean,
  onError: (reason: unknown) => void,
): Promise<void> {
  try {
    const value = await load();
    if (isActive()) apply(value);
  } catch (reason) {
    if (isActive()) onError(reason);
  }
}
