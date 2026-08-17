// Cevaplanan görevin devam etmesi.
//
// NEDEN VAR ve NEDEN KUYRUK DEĞİL: cevap akışı yalnızca zamanlayıcı yarısını
// (`resumeUserAnswer`) çağırıyordu. O çağrı görevi 'waiting_user' → 'escalated'
// → 'working' yapar ve AYNI SAHİPLE taze bir deneme açar; yani görev artık
// ATANMIŞTIR. İlk düzeltmede görevi kuyruğa koymayı denedim: pompa kuyruktan
// alınan görevi `assign` ile işlediği için her turda
//   TaskDeferredError: task atama icin queued degil: <id>:working
// ile reddetti — görev 30 saniyede bir reddedilen sonsuz bir döngüye girdi.
//
// Atanmış görev atama değil YÜRÜTME bekler. Bunun tam yaşam döngüsü
// `resumePhase1Orchestrator` olarak yazılmış ve composition'da `resume` diye
// açığa çıkarılmıştı, ama hiçbir üretim yolu onu çağırmıyordu — deponun en
// pahalı hata sınıfının bir örneği daha.
import type { EntityId } from '@ww/shared';

export interface ResumeAnsweredTaskPorts {
  /** Tam devam yaşam döngüsü: cevabı işler, çalıştırır, doğrular, kapıdan geçirir. */
  resume(): Promise<Readonly<{ status: string }>>;
  onDone?(status: string): void;
  onError?(reason: unknown): void;
}

/** Cevap için görevin sürdürülebilir olduğu durumlar. */
const RESUMABLE_STATUSES: ReadonlySet<string> = new Set(['waiting_user', 'escalated']);

export function isResumableStatus(status: string): boolean {
  return RESUMABLE_STATUSES.has(status);
}

/**
 * Yaşam döngüsü dakikalarca sürebilir; çağıran bunu HTTP cevabından AYRI
 * koşturur. Bu yüzden burada hata DIŞARI SIZMAZ: cevap zaten kalıcı olarak
 * yazılmıştır, onu reddetmek kullanıcının yazdığını çöpe atardı. Ama sessiz
 * de kalınmaz — yutulan hata görevi görünmez biçimde asar.
 */
export async function resumeAnsweredTask(
  taskId: EntityId,
  ports: ResumeAnsweredTaskPorts,
): Promise<boolean> {
  try {
    const outcome = await ports.resume();
    ports.onDone?.(outcome.status);
    return true;
  } catch (reason) {
    ports.onError?.(reason);
    return false;
  }
}
