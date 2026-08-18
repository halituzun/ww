import { NIL_UUID } from '@ww/shared';
// Kuyruk yeniden doldurma planı (docs/07 → Kurtarma, adım 3).
//
// NEDEN VAR: ClickHouse'da `queued` duran ama Redis stream'inde karşılığı
// olmayan görev SONSUZA DEK bekler — kuyruğu tüketen kimse onu görmez.
// Bu, Redis silindiğinde/temizlendiğinde ya da stream budandığında gerçekten
// oluyor. RecoveryService yalnızca TAKILI görevleri (assigned/working…) geri
// kuyruğa düşürüyordu; zaten `queued` olanlar kör noktaydı.
export interface QueueRefillContext {
  /**
   * Görevin plan kimliği. NIL/boş ise görev ATANAMAZ ve kuyruğa konması
   * sonsuz bir döngü açar (aşağıdaki açıklamaya bakın).
   */
  readonly planIdOf: (taskId: string) => string;
}

/** Plansız görev atamada reddedilir: `task plan kimligi tasimiyor`. */
const isAssignable = (planId: string): boolean =>
  planId !== '' && planId !== NIL_UUID;

export function planQueueRefill(
  queuedTaskIds: readonly string[],
  streamTaskIds: readonly string[],
  context?: QueueRefillContext,
): readonly string[] {
  const present = new Set(streamTaskIds);
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const taskId of queuedTaskIds) {
    if (present.has(taskId)) continue;
    // ATANAMAZ GÖREVİ GERİ KOYMA. Ölçüldü (canlı ClickHouse, 2026-08-18):
    // aynı kimlikler 51 kez "onarıldı". Plansız görevi pompa her seferinde
    // reddeder, teslim sınırı dolunca mesaj akıştan silinir, kurtarma onu
    // geri koyar — sonsuza dek. Bu döngü hem CPU hem olay günlüğü yakar
    // (kurtarma olayları tüm günlüğün %65'iydi).
    //
    // `attempt` bu döngüde 0'da kalır (ret ATAMADAN ÖNCE olur), bu yüzden
    // `max_attempts` freni hiç devreye girmez; döngüyü kesen tek şey budur.
    if (context !== undefined && !isAssignable(context.planIdOf(taskId))) continue;
    // Aynı görevi iki kez eklemek onu iki kez çalıştırmayı dener.
    if (seen.has(taskId)) continue;
    seen.add(taskId);
    missing.push(taskId);
  }
  return Object.freeze(missing);
}
