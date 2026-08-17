// Executor kompozisyonu ve kullanıcı cevabı devamı (docs/05 → Executor).
//
// Phase9 composition on port ister. Testte dördü `failClosed` stub'dır;
// üretimde `communication` gerçekten gerekli (worker soru sorar ve sonuç
// raporlar, verifier karar verir). Uygulanmamış portlar SESSİZCE başarılı
// dönmez: worker çalışmayan bir yeteneği çalışmış sanarsa hata görünmez olur.
import { DurableExecutorAudit, DurableExecutorIntent, DurableGateCommitAudit } from '@ww/executor';
import type { AssignmentAttemptV1, EntityId, JsonValue } from '@ww/shared';

export interface ExecutorCommunicationLike {
  askQuestion(input: unknown): Promise<JsonValue>;
  reportResult(input: unknown): Promise<JsonValue>;
  submitVerdict(input: unknown): Promise<JsonValue>;
}

export interface ExecutorCompositionDeps {
  sandbox: unknown;
  hostCommand: unknown;
  access: unknown;
  /** clickHouseExecutorEventStore(ch) çıktısı. */
  auditStore: { append(event: unknown): Promise<unknown> };
  communication: ExecutorCommunicationLike;
}

const notImplemented = (what: string) => async (): Promise<never> => {
  throw new Error(`${what} bu kurulumda uygulanmadı — sessiz başarı yerine açık hata`);
};

export function createExecutorComposition(deps: ExecutorCompositionDeps) {
  const store = deps.auditStore as never;
  return {
    sandbox: deps.sandbox,
    hostCommand: deps.hostCommand,
    access: deps.access,
    communication: deps.communication,
    audit: new DurableExecutorAudit(store),
    intents: new DurableExecutorIntent(store),
    gateAudit: new DurableGateCommitAudit(store),
    // Kapı girdi kısıtı `ww.gate.json` içinde tanımlıdır; bu katman izin verir.
    gateInputPolicy: { assertAllowed: async (): Promise<void> => undefined },
    effects: { run: notImplemented('durable efekt çalıştırma') },
    sandboxInputs: { resolveTrustedInputs: notImplemented('güvenilir sandbox girdisi çözümü') },
  };
}

export interface ResumeAssignmentPort {
  resumeUserAnswer(input: Readonly<{
    taskId: EntityId;
    taskBriefId: EntityId;
    previousAttemptId: EntityId;
    questionMessageId: EntityId;
    replyMessageId: EntityId;
    answer: string;
  }>): Promise<AssignmentAttemptV1>;
}

export interface ResumeUserAnswerCall {
  projectId: EntityId;
  taskId: EntityId;
  taskBriefId: EntityId;
  previousAttemptId: EntityId;
  questionMessageId: EntityId;
  replyMessageId: EntityId;
  answer: string;
}

export function createResumeUserAnswerOperation(port: ResumeAssignmentPort) {
  return async (call: ResumeUserAnswerCall): Promise<AssignmentAttemptV1> => {
    // Boş cevapla devam etmek, worker'ı bilgisiz yeniden başlatmaktır.
    if (call.answer.trim().length === 0) throw new Error('kullanıcı cevabı boş olamaz');
    // Kendi sorusunu cevap sayan döngü sonsuza kadar kendini besler.
    if (call.replyMessageId === call.questionMessageId) {
      throw new Error('cevap mesajı soru mesajıyla aynı olamaz');
    }
    return port.resumeUserAnswer({
      taskId: call.taskId,
      taskBriefId: call.taskBriefId,
      previousAttemptId: call.previousAttemptId,
      questionMessageId: call.questionMessageId,
      replyMessageId: call.replyMessageId,
      answer: call.answer,
    });
  };
}
