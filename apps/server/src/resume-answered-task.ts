// Cevaplanan görevin devam etmesi: SÜRDÜR + KUYRUĞA KOY.
//
// NEDEN VAR: cevap akışı yalnızca `resumeUserAnswer` çağırıyordu. O çağrı
// görevi 'waiting_user' → 'working' yapar ama kuyruk kaydını YENİDEN AÇMAZ —
// soru sorulduğunda mesaj zaten ack'lenmişti. Sonuç: kullanıcı cevap verir,
// panel görevi "çalışıyor" gösterir, ama hiçbir tüketici onu görmez ve görev
// sonsuza dek asılı kalır. Canlı satranç koşusunda tam olarak böyle takıldı.
//
// "Durumu değiştirdim" ile "işi teslim ettim" farklı şeylerdir; bu deponun
// en pahalı hata sınıfı ikisinin karıştırılmasıdır.
import type { EntityId } from '@ww/shared';

export interface ResumeAnsweredTaskPorts {
  resume(): Promise<void>;
  enqueue(taskId: EntityId): Promise<void>;
  onError?(reason: unknown): void;
}

/** Cevap için görevin sürdürülebilir olduğu durumlar. */
const RESUMABLE_STATUSES: ReadonlySet<string> = new Set(['waiting_user', 'escalated']);

export function isResumableStatus(status: string): boolean {
  return RESUMABLE_STATUSES.has(status);
}

export async function resumeAnsweredTask(
  taskId: EntityId,
  ports: ResumeAnsweredTaskPorts,
): Promise<boolean> {
  await ports.resume();
  try {
    await ports.enqueue(taskId);
    return true;
  } catch (reason) {
    // Sürdürme YAPILMIŞTIR: cevabı reddetmek kullanıcının yazdığını çöpe
    // atardı. Ama sessiz kalmak görevi görünmez biçimde asardı; kurtarma
    // taraması 'working' görevleri yeniden kuyruğa alabilsin diye bildirilir.
    ports.onError?.(reason);
    return false;
  }
}
