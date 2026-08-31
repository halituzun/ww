import { createHash } from 'node:crypto';
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

/**
 * Tırmandırmanın `events` ucu (docs/03: "Her basamak `messages`'a escalation
 * kaydı + `events`'e escalation olayı yazar"). Olay tarafı hiç yazılmıyordu;
 * denetim ekranı bunu iki kaynağı birleştirerek örtmek zorunda kalmıştı.
 */
export interface EscalationEventPort {
  readonly appendEvent: (row: Readonly<Record<string, unknown>>) => Promise<unknown>;
  /** Olay yazımı tırmandırmayı düşürmez ama sessiz de kalmaz. */
  readonly onError?: ((reason: unknown) => void) | undefined;
}

/**
 * Aynı tırmandırma iki kez teslim edilirse olay TEKİLLEŞMELİ: denetim ekranı
 * aynı olayı iki kez sayarsa "kaç fren tetiklendi" yanlış olur. Kimlik,
 * mesajın idempotency anahtarından türetilir — iki uç aynı şeyi tekil sayar.
 */
export function escalationEventId(idempotencyKey: string): string {
  const hex = createHash('sha256').update(idempotencyKey).digest('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join('-');
}

function isEffectEscalation(input: TypedEscalation): input is EffectEscalationV1 {
  return 'stableEffectId' in input;
}

/** Routes code-owned failures through CommunicationService so message + receipt stay canonical. */
export class CommunicationEscalationDelivery
implements EffectEscalationPort, ReceiptEscalationPort {
  readonly #communication: CommunicationService;
  readonly #authentication: PrincipalAuthentication;
  readonly #events: EscalationEventPort | undefined;

  constructor(
    communication: CommunicationService,
    authentication: PrincipalAuthentication,
    events?: EscalationEventPort,
  ) {
    if (authentication.type !== 'internal_service') {
      throw new Error('escalation delivery internal_service authentication gerektirir');
    }
    this.#communication = communication;
    this.#authentication = authentication;
    this.#events = events;
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
    const envelope = await this.#communication.send(this.#authentication, send);

    // Mesaj TESLİMATTIR (PM'e ulaşan uyarı), olay denetim izidir. Olay yazımı
    // düşerse tırmandırma DÜŞMEZ: ulaşmış bir uyarıyı kaydı tutulamadı diye
    // iptal etmek sorunu büyütürdü. Sessiz de kalmaz.
    if (this.#events !== undefined) {
      try {
        await this.#events.appendEvent({
          event_id: escalationEventId(idempotencyKey),
          seq: '0',
          project_id: input.projectId,
          task_id: input.taskId ?? null,
          agent_id: input.owningPmId,
          event_type: 'escalation',
          tool_name: '',
          payload: { reason, evidenceRefs },
          duration_ms: 0,
          created_at: input.createdAt,
        });
      } catch (reason_) {
        this.#events.onError?.(reason_);
      }
    }
    return envelope;
  }
}
