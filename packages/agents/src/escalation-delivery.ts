import type { SendMessageInputV1 } from '@ww/shared';
import { CommunicationService } from './communication-service.js';
import type {
  EffectEscalationPort,
  EffectEscalationV1,
  PrincipalAuthentication,
  ReceiptEscalationPort,
  ReceiptEscalationV1,
} from './ports.js';

type TypedEscalation = EffectEscalationV1 | ReceiptEscalationV1;

function isEffectEscalation(input: TypedEscalation): input is EffectEscalationV1 {
  return 'stableEffectId' in input;
}

/** Routes code-owned failures through CommunicationService so message + receipt stay canonical. */
export class CommunicationEscalationDelivery
implements EffectEscalationPort, ReceiptEscalationPort {
  readonly #communication: CommunicationService;
  readonly #authentication: PrincipalAuthentication;

  constructor(
    communication: CommunicationService,
    authentication: PrincipalAuthentication,
  ) {
    if (authentication.type !== 'internal_service') {
      throw new Error('escalation delivery internal_service authentication gerektirir');
    }
    this.#communication = communication;
    this.#authentication = authentication;
  }

  async append(input: TypedEscalation) {
    const reason = isEffectEscalation(input)
      ? 'NON_REPLAY_SAFE_EFFECT_UNCERTAIN'
      : input.reasonCode;
    const evidenceRefs = isEffectEscalation(input)
      ? [
        `causation:${input.causationId}`,
        `effect:${input.stableEffectId}`,
        `effect_type:${input.effectType}`,
      ]
      : [
        `causation:${input.causationId}`,
        `receipt:${input.receiptId}`,
        `retry_count:${input.retryCount}`,
      ];
    const idempotencyKey = isEffectEscalation(input)
      ? `escalation:effect:${input.causationId}:${input.stableEffectId}`
      : `escalation:receipt:${input.receiptId}`;
    const send: SendMessageInputV1 = {
      projectId: input.projectId,
      sessionId: input.sessionId,
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      ...(input.taskBriefId === undefined ? {} : { taskBriefId: input.taskBriefId }),
      ...(input.assignmentAttemptId === undefined
        ? {}
        : { assignmentAttemptId: input.assignmentAttemptId }),
      recipient: { type: 'agent', id: input.owningPmId },
      kind: 'escalation',
      payload: { type: 'escalation', reason, evidenceRefs },
      correlationId: input.causationId,
      causationId: input.causationId,
      idempotencyKey,
      provenance: { class: 'system_generated', sourceId: input.causationId },
      priority: 'urgent',
      createdAt: input.createdAt,
    };
    return this.#communication.send(this.#authentication, send);
  }
}
