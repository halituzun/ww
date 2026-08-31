// Tırmandırmanın üretim yazıcısı (docs/03 → Tırmandırma Zinciri).
//
// `Phase1SchedulerPort.escalate` üretim karşılığı yoktu: frenler onu
// çağırıyor, denetim paneli `events`'teki `escalation` satırlarını okuyor,
// ama arada yazan kimse yoktu. Zincirin ortası boştu.
import { appendEvent, type ClickHouseClient } from '@ww/db';
import { NIL_UUID, type AssignmentAttemptV1, type EntityId } from '@ww/shared';
import { deterministicSchedulerEntityId } from './ports.js';

export interface EscalationInput {
  taskId: EntityId;
  attempt: AssignmentAttemptV1;
  reason: string;
  /** Replay'in birebir aynı kaydı üretmesi için sabitlenebilir. */
  occurredAt?: string;
}

export type EscalationRecorder = (input: EscalationInput) => Promise<void>;

/** Frenler `brake:<tür>: mesaj` biçiminde gerekçe üretir. */
const BRAKE_REASON = /^brake:([a-z_]+)/;

export function createEscalationRecorder(ch: ClickHouseClient): EscalationRecorder {
  return async (input) => {
    const { taskId, attempt, reason } = input;
    const text = reason.trim();
    if (text.length === 0) throw new Error('tırmandırma gerekçesi boş olamaz');

    const brakeKind = BRAKE_REASON.exec(text)?.[1] ?? '';
    const occurredAt = input.occurredAt ?? new Date().toISOString();

    // Kimlik deterministik: crash/replay aynı tırmandırmayı iki kez yazmasın.
    const eventId = deterministicSchedulerEntityId('task-escalation-v1', [
      attempt.assignmentAttemptId,
      text,
    ].join('|'));

    // Aynı attempt + aynı gerekçe mantıksal olarak AYNI tırmandırmadır; yalnız
    // saat okuması farklıdır. Depo bunu içerik çatışması sayar, o yüzden
    // kaydın zaten var olduğu doğrulanıp sessizce geçilir. Gerekçe FARKLIYSA
    // çatışma gerçektir ve yutulmaz.
    const existing = await readStoredReason(ch, eventId);
    if (existing !== undefined) {
      if (existing === text) return;
      throw new Error(`tırmandırma kimliği çakıştı: '${existing}' != '${text}'`);
    }

    await appendEvent(ch, {
      event_id: eventId,
      seq: String(Date.parse(occurredAt)),
      project_id: attempt.projectId,
      task_id: taskId,
      // Tırmandırmayı başlatan worker izlenebilir olmalı.
      agent_id: attempt.workerAgentId ?? NIL_UUID,
      event_type: 'escalation',
      tool_name: '',
      payload: {
        contractVersion: 1,
        reason: text,
        // Panel fren tetiklenmesini normal tırmandırmadan ayırabilsin diye
        // tür ayrı alanda da durur (gerekçe metnini ayrıştırmaya bırakılmaz).
        brakeKind,
        assignmentAttemptId: attempt.assignmentAttemptId,
        taskBriefId: attempt.taskBriefId,
        attemptNumber: attempt.attemptNumber,
      },
      duration_ms: 0,
      created_at: occurredAt,
    });
  };
}

async function readStoredReason(ch: ClickHouseClient, eventId: EntityId): Promise<string | undefined> {
  const result = await ch.query({
    query: `SELECT JSONExtractString(payload, 'reason') AS reason
      FROM events WHERE event_id = {eventId:UUID} LIMIT 1`,
    query_params: { eventId },
    format: 'JSONEachRow',
  });
  const rows = await result.json<{ reason: string }>();
  return rows[0]?.reason;
}
