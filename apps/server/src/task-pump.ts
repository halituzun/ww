// Görev pompası: kuyruğa düşen işi fiilen çalıştıran halka.
//
// NEDEN VAR: motor "ETKİN" raporluyordu ama görevler sonsuza dek 'queued'
// kalıyordu. Sebep: kuyruğu tüketen `SchedulerWorker` yalnızca ATAMA yapar,
// tam yaşam döngüsünü ise composition'ın `orchestrate`'i koşturur — ve
// ikisini birleştiren hiçbir üretim kodu yoktu. Kayıt ≠ tüketim; bu ayrımın
// görünmez kalması deponun en pahalı hata sınıfıdır.
import type { EntityId } from '@ww/shared';

export interface PumpItem {
  readonly msgId: string;
  readonly taskId: EntityId;
}

export interface PumpItemResult {
  readonly taskId: EntityId;
  readonly status: string;
}

export interface PumpResult {
  readonly processed: number;
  readonly results: readonly PumpItemResult[];
}

export interface TaskPumpPorts {
  /** Kuyruktan teslim alınan mesajlar (grup + reclaim semantiği çağıranda). */
  claim(): Promise<readonly PumpItem[]>;
  ack(msgId: string): Promise<void>;
  /**
   * Brief'i pompa MÜHÜRLEMEZ: atama onu agent'ların prompt sürümleriyle
   * mühürler ve agent seçimi worker'ın prompt'unun brief'le eşleşmesini ister.
   * Pompa ayrıca mühürleyince o eşleşme bozuluyor ("idle worker bulunamadi").
   */
  orchestrate(input: Readonly<{
    taskId: EntityId;
    maxAttempts: number;
  }>): Promise<Readonly<{ status: string }>>;
  readonly maxAttempts?: number;
  onResult?(taskId: EntityId, status: string): void;
  onError?(taskId: EntityId, reason: unknown): void;
}

/**
 * Mesajın kapatılabileceği sonuçlar. Terminal OLMAYAN bir sonuçta ack etmek
 * işi kaybetmektir: görev retry edilebilir bir duruma (working) düşerken
 * kuyruk kaydı kapanıyor, kimse onu tekrar almıyor ve görev agent'larını
 * tutarak asılı kalıyordu — tek yarım iş projeyi kilitliyordu.
 */
const CLOSABLE_STATUSES: ReadonlySet<string> = new Set([
  'done', 'failed', 'cancelled', 'escalated', 'awaiting_user', 'waiting_user',
]);

export async function pumpOnce(ports: TaskPumpPorts): Promise<PumpResult> {
  const items = await ports.claim();
  const results: PumpItemResult[] = [];

  for (const item of items) {
    try {
      const outcome = await ports.orchestrate({
        taskId: item.taskId,
        maxAttempts: ports.maxAttempts ?? 3,
      });
      results.push({ taskId: item.taskId, status: outcome.status });
      ports.onResult?.(item.taskId, outcome.status);

      // İş bitti (terminal ya da kullanıcı cevabı bekliyor): mesaj kapanır.
      // Soru bekleyen görevi kuyrukta bırakmak onu sürekli yeniden koşturur.
      // Terminal olmayan sonuçta mesaj AÇIK kalır ki reclaim işi devralsın.
      if (!CLOSABLE_STATUSES.has(outcome.status)) continue;
      try {
        await ports.ack(item.msgId);
      } catch (reason) {
        // Ack düşse bile İŞ YAPILMIŞTIR; pompa durmamalı ama sessiz de
        // kalmamalı — yoksa mesaj sonsuza dek yeniden teslim edilir.
        ports.onError?.(item.taskId, reason);
      }
    } catch (reason) {
      // ACK YOK: mesaj pending kalır ve reclaim başka tüketiciye devreder.
      // Burada ack'lemek işi sessizce kaybetmek olurdu.
      results.push({ taskId: item.taskId, status: 'error' });
      ports.onError?.(item.taskId, reason);
    }
  }

  return { processed: items.length, results };
}
