// `Phase1SchedulerPort` atama işlemlerinin üretim karşılıkları.
//
// Orkestratör dar bir sözleşme kullanır; AssignmentService ise nedensellik
// alanlarını (requestedAt, causationId) ister. Bu modül köprüyü kurar.
import { randomUUID } from 'node:crypto';
import type { AssignmentAttemptV1, EntityId } from '@ww/shared';

export type ReassignReason = 'retry_after_rejection' | 'retry_after_gate_failure';

const REASSIGN_REASONS: readonly string[] = ['retry_after_rejection', 'retry_after_gate_failure'];

export interface AssignmentOperationPort {
  reassign(input: Readonly<{
    taskId: EntityId;
    requestedAt: string;
    causationId: EntityId;
  }>): Promise<AssignmentAttemptV1>;
}

export interface ReassignCall {
  taskId: EntityId;
  reason: ReassignReason;
  evidenceRefs: readonly string[];
}

export function createReassignOperation(port: AssignmentOperationPort) {
  return async ({ taskId, reason }: ReassignCall): Promise<AssignmentAttemptV1> => {
    if (!REASSIGN_REASONS.includes(reason)) {
      throw new Error(`geçersiz yeniden atama gerekçesi: ${reason}`);
    }
    // Her yeniden atama ayrı bir nedensel olaydır; paylaşılan causationId
    // iki denemeyi tek olay gibi gösterir ve iz sürmeyi bozar.
    return port.reassign({
      taskId,
      requestedAt: new Date().toISOString(),
      causationId: randomUUID() as EntityId,
    });
  };
}

export interface UserQuestionRecord {
  projectId: EntityId;
  taskId: EntityId;
  taskBriefId: EntityId;
  assignmentAttemptId: EntityId;
  question: string;
  questionMessageId?: EntityId;
  askedAt: string;
}

export interface UserQuestionPort {
  recordQuestion(record: UserQuestionRecord): Promise<void>;
}

export interface AwaitUserAnswerCall {
  taskId: EntityId;
  attempt: AssignmentAttemptV1;
  question: string;
  questionMessageId?: EntityId;
}

export function createAwaitUserAnswerOperation(port: UserQuestionPort) {
  return async ({ taskId, attempt, question, questionMessageId }: AwaitUserAnswerCall): Promise<void> => {
    const text = question.trim();
    // Boş soru kullanıcıya anlamsız bir bekleme yaratır: görev sonsuza dek
    // waiting_user'da kalır ve kimse neyin sorulduğunu bilmez.
    if (text.length === 0) throw new Error('worker sorusu boş olamaz');

    await port.recordQuestion({
      projectId: attempt.projectId,
      taskId,
      taskBriefId: attempt.taskBriefId,
      assignmentAttemptId: attempt.assignmentAttemptId,
      question: text,
      ...(questionMessageId === undefined ? {} : { questionMessageId }),
      askedAt: new Date().toISOString(),
    });
  };
}
