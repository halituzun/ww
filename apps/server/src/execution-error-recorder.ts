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
        payload: JSON.stringify({
          phase: call.phase,
          reason,
          // Yığın izi olmadan "nerede patladı" sorusu koda bakarak aranıyor.
          stack: call.error instanceof Error ? (call.error.stack ?? '') : '',
          assignmentAttemptId: attempt.assignmentAttemptId,
        }),
        duration_ms: 0,
        created_at: input.now(),
      });
    } catch (writeError) {
      // Kaydedici, hata yolunu ikinci bir hatayla kırmamalı: görev yine de
      // 'failed' olmalı ki durum belirsiz kalmasın. Ama sessiz de kalmaz.
      input.log(`hata olayı yazılamadı: ${reasonText(writeError)}`);
    }

    try {
      await input.transition({
        taskId: call.taskId,
        attempt: call.attempt,
        action: ACTION_BY_PHASE[call.phase] ?? 'fail',
        resultSummary: reason,
      });
    } catch (transitionError) {
      // Geçiş reddedilse bile çağıranın gördüğü sonuç 'failed' olmalı;
      // sessizce başarılı görünmek durumu belirsiz bırakırdı.
      input.log(`görev ${call.taskId} 'failed' durumuna geçirilemedi: ${reasonText(transitionError)}`);
    }

    return 'failed';
  };
}
