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
  log(message: string): void;
  now(): string;
}

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

    return 'failed';
  };
}
