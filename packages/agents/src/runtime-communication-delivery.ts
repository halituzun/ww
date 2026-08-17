// Worker'ın soru/rapor kanalını gerçek `CommunicationService`'e bağlar.
//
// NEDEN VAR: köprü (`createPhase1RuntimeBridge`) bir iletişim portu ister ama
// portu kuran taraf uzun süre onu sahte bıraktı: soru "gönderildi" sayılıp
// hiçbir yere yazılmıyordu. Bu, deponun en pahalı hata sınıfı olan SESSİZ
// BAŞARI'dır — worker cevap bekler, kullanıcı soruyu hiç görmez, görev
// zaman aşımına kadar asılı kalır. Buradaki tek iş, iki çağrıyı kanonik
// mesaj boru hattına çevirmektir; hata yutulmaz, kimlik uydurulmaz.
import type { EntityId, SendMessageInputV1 } from '@ww/shared';
import type { CommunicationService } from './communication-service.js';
import type { PrincipalAuthentication } from './ports.js';

export interface RuntimeTaskScope {
  readonly projectId: EntityId;
  readonly taskId: EntityId;
  readonly taskBriefId: EntityId;
  readonly assignmentAttemptId: EntityId;
}

export interface RuntimeCommunicationDeliveryInput {
  readonly communication: CommunicationService;
  /**
   * Gönderen KİMLİĞİ denemeye göre çözülür: worker kendi adına konuşmalıdır.
   * 'system' kimliği yalnızca kod-kaynaklı tırmandırma içindir; worker
   * raporunu system olarak göndermek politika tarafından reddedilir.
   */
  readonly authenticateAs: (attemptId: EntityId) => Promise<PrincipalAuthentication>;
  readonly authentication: PrincipalAuthentication;
  readonly sessionId: EntityId;
  /** Soruların ilk düştüğü yer: projenin PM agent'ı (docs/03 tırmandırma zinciri). */
  readonly owningPmId: EntityId;
  readonly now: () => string;
}

export interface RuntimeCommunicationDeliveryPort {
  question(input: Readonly<RuntimeTaskScope & {
    callId: EntityId;
    text: string;
  }>): Promise<Readonly<{ messageId: EntityId }>>;
  report(
    summary: string,
    evidenceRefs: readonly string[],
    provenance: Readonly<RuntimeTaskScope & {
      invocationId: EntityId;
      promptInputSnapshotId: EntityId;
    }>,
  ): Promise<void>;
}

const scopeOf = (scope: RuntimeTaskScope) => ({
  projectId: scope.projectId,
  taskId: scope.taskId,
  taskBriefId: scope.taskBriefId,
  assignmentAttemptId: scope.assignmentAttemptId,
});

export function createRuntimeCommunicationDelivery(
  input: RuntimeCommunicationDeliveryInput,
): RuntimeCommunicationDeliveryPort {
  if (input.authentication.type !== 'internal_service') {
    throw new Error('runtime iletişim teslimi internal_service authentication gerektirir');
  }

  const port: RuntimeCommunicationDeliveryPort = {
    async question(call) {
      const send: SendMessageInputV1 = {
        ...scopeOf(call),
        sessionId: input.sessionId,
        recipient: { type: 'agent', id: input.owningPmId },
        kind: 'question',
        payload: { type: 'question', text: call.text },
        // Aynı araç çağrısının tekrarı ikinci bir soru açmamalı.
        idempotencyKey: `runtime:question:${call.assignmentAttemptId}:${call.callId}`,
        causationId: call.callId,
        provenance: { class: 'model_output', sourceId: call.callId },
        priority: 'normal',
        createdAt: input.now(),
      };
      // Kimlik kanonik boru hattından gelir; burada üretmek "yazıldı" yalanıdır.
      const sender = await input.authenticateAs(call.assignmentAttemptId);
      const envelope = await input.communication.send(sender, send);
      return Object.freeze({ messageId: envelope.messageId });
    },

    async report(summary, evidenceRefs, provenance) {
      const send: SendMessageInputV1 = {
        ...scopeOf(provenance),
        sessionId: input.sessionId,
        recipient: { type: 'agent', id: input.owningPmId },
        kind: 'report',
        payload: { type: 'report', summary, evidenceRefs: [...evidenceRefs] },
        idempotencyKey: `runtime:report:${provenance.assignmentAttemptId}:${provenance.invocationId}`,
        causationId: provenance.invocationId,
        // Raporu üreten mühürlü girdiye bağlar: "bu sonucu hangi çağrı yazdı".
        invocationId: provenance.invocationId,
        promptInputSnapshotId: provenance.promptInputSnapshotId,
        provenance: { class: 'model_output', sourceId: provenance.invocationId },
        priority: 'normal',
        createdAt: input.now(),
      };
      const sender = await input.authenticateAs(provenance.assignmentAttemptId);
      await input.communication.send(sender, send);
    },
  };
  return Object.freeze(port);
}
