// Çalışma sırasında düşen görevin SEBEBİNİ kaydeder.
//
// NEDEN VAR: `handleExecutionError` sabit `'failed'` dönen bir taslaktı —
// hatayı tümüyle çöpe atıyordu. Sonuç: görev 'failed' oluyor, ne loglarda
// ne veritabanında tek satır iz kalıyordu; başarısızlık teşhis edilemezdi.
// Santranç görevi tam olarak böyle düştü ve sebebi ancak koda bakarak
// bulunabildi.
import { randomUUID } from 'node:crypto';
import type { AssignmentAttemptV1, EntityId, TaskStatus } from '@ww/shared';

export interface ExecutionErrorInput {
  readonly taskId: EntityId;
  readonly attempt: AssignmentAttemptV1;
  readonly phase: 'working' | 'verifying' | 'testing' | 'committing';
  readonly error: unknown;
}

export interface ExecutionErrorRecorderInput {
  appendEvent(row: unknown): Promise<unknown>;
  /**
   * Görevi fiilen 'failed'e geçirir. Yalnızca durum STRING'i döndürmek
   * yetmez: geçiş olmadan görev satırı 'assigned' kalır ve DOSYA KİLİDİ
   * bırakılmaz — aynı dosyayı hedefleyen sonraki görev TTL dolana dek çakışır.
   */
  transition(call: Readonly<{
    taskId: EntityId;
    attempt: AssignmentAttemptV1;
    action: string;
    resultSummary?: string;
  }>): Promise<unknown>;
  /* Geçişin SONUCU okunur; bkz. aşağıdaki "durum gerçeği" notu. */
  log(message: string): void;
  now(): string;
}

/**
 * FSM'de 'fail' YALNIZCA working durumundan geçerlidir. Aşamaya bakmadan
 * 'fail' göndermek "gecersiz task FSM gecisi: testing --fail--> ?" ile
 * düşüyor ve görev takılı kalıyordu.
 */
const ACTION_BY_PHASE: Readonly<Record<string, string>> = Object.freeze({
  working: 'fail',
  verifying: 'verifier_rejected',
  testing: 'gate_failed',
  committing: 'fail',
});

const reasonText = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

export function createExecutionErrorRecorder(input: ExecutionErrorRecorderInput) {
  return async (call: ExecutionErrorInput): Promise<TaskStatus> => {
    const reason = reasonText(call.error);
    const attempt = call.attempt as unknown as {
      projectId: EntityId;
      assignmentAttemptId: EntityId;
      workerAgentId?: EntityId;
    };

    input.log(`görev ${call.taskId} '${call.phase}' aşamasında düştü: ${reason}`);

    try {
      await input.appendEvent({
        event_id: randomUUID(),
        seq: '0',
        project_id: attempt.projectId,
        task_id: call.taskId,
        agent_id: attempt.workerAgentId ?? null,
        event_type: 'error',
        tool_name: '',
        // NESNE olarak yazılır, JSON METNİ olarak değil. `payload` alanı
        // zaten JsonValue'dur ve depo onu serileştirir; burada bir kez daha
        // JSON.stringify yapmak yükü ÇİFT KODLUYORDU. Sonuç: 69 hata
        // olayının 69'unda `JSONExtractString(payload,'reason')` boş
        // dönüyordu — sebep yazılı olduğu hâlde denetim ekranı, anlatıcı ve
        // her analitik sorgu onu okuyamıyordu. Anlatıcı bu yüzden "hata:
        // sebep kaydedilmemiş" diyordu; kayıt vardı, okunamıyordu.
        payload: {
          phase: call.phase,
          reason,
          // Yığın izi olmadan "nerede patladı" sorusu koda bakarak aranıyor.
          stack: call.error instanceof Error ? (call.error.stack ?? '') : '',
          assignmentAttemptId: attempt.assignmentAttemptId,
        },
        duration_ms: 0,
        created_at: input.now(),
      });
    } catch (writeError) {
      // Kaydedici, hata yolunu ikinci bir hatayla kırmamalı: görev yine de
      // 'failed' olmalı ki durum belirsiz kalmasın. Ama sessiz de kalmaz.
      input.log(`hata olayı yazılamadı: ${reasonText(writeError)}`);
    }

    // DURUM GERÇEĞİ: burada uygulanan geçiş her zaman 'failed' ÜRETMEZ.
    // 'verifier_rejected' ve 'gate_failed' görevi (deneme hakkı bitmedikçe)
    // 'working'e geri döndürür. Buna rağmen bu fonksiyon koşulsuz 'failed'
    // dönüyordu ve görev pompası 'failed'i "kapanabilir" sayıp mesajı
    // kuyruktan SİLİYORDU. Sonuç: tasks satırı 'working', kuyrukta kayıt yok,
    // worker/verifier 'busy' kilitli, panel "çalışıyor" diyor — görev sessizce
    // asılı kalıyordu. Artık geçişin GERÇEK sonucu döner; 'working' dönünce
    // pompa mesajı ack'lemez ve görev yeniden denenir.
    try {
      const result = await input.transition({
        taskId: call.taskId,
        attempt: call.attempt,
        action: ACTION_BY_PHASE[call.phase] ?? 'fail',
        resultSummary: reason,
      });
      const status = (result as { status?: unknown } | null)?.status;
      if (typeof status === 'string') return status as TaskStatus;
      // Geçiş sonucu okunamıyorsa durum belirsizdir; belirsizi 'failed'
      // saymak, kuyrukta sonsuza dek dönen bir mesajdan iyidir.
      input.log(`görev ${call.taskId} geçiş sonucu okunamadı; 'failed' varsayıldı`);
      return 'failed';
    } catch (transitionError) {
      // Geçiş reddedilse bile çağıranın gördüğü sonuç 'failed' olmalı;
      // sessizce başarılı görünmek durumu belirsiz bırakırdı.
      input.log(`görev ${call.taskId} 'failed' durumuna geçirilemedi: ${reasonText(transitionError)}`);
      return 'failed';
    }
  };
}
