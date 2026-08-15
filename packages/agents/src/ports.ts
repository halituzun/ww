import type {
  AgentMessageEnvelopeV1,
  AuthenticatedPrincipalV1,
  EntityId,
  JsonValue,
  PartyRefV1,
  TaskTransitionRequestV1,
} from '@ww/shared';
import { EntityIdSchema, canonicalSha256V1 } from '@ww/shared';
import type { DueInboxItemRecord, EffectReplaySafety, MessageReceiptRow } from '@ww/db';
import type { InvalidDueMessageReceiptCode } from '@ww/db';

export type PrincipalAuthentication =
  | Readonly<{ type: 'local_user'; credential: string; issuedAt: string }>
  | Readonly<{ type: 'agent_capability'; credential: string; issuedAt: string }>
  | Readonly<{ type: 'internal_service'; credential: string; issuedAt: string }>;

export interface AgentCapabilityBinding {
  readonly projectId: EntityId;
  readonly agentId: EntityId;
}

export interface ClockPort {
  now(): string;
}

export const systemClock: ClockPort = Object.freeze({
  now: () => new Date().toISOString(),
});

export function deterministicAgentEntityId(namespace: string, value: unknown): EntityId {
  const hex = canonicalSha256V1({ namespace, value });
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return EntityIdSchema.parse(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`,
  );
}

export interface TaskTransitionPort {
  apply(
    principal: AuthenticatedPrincipalV1,
    request: TaskTransitionRequestV1,
  ): Promise<unknown>;
}

export interface InboxItemV1 {
  readonly message: DueInboxItemRecord['message'];
  readonly receipt: MessageReceiptRow;
}

export type ProcessResult =
  | Readonly<{ state: 'idle'; recipient: PartyRefV1 }>
  | Readonly<{
    state: 'busy';
    recipient: PartyRefV1;
    receiptId: EntityId;
  }>
  | Readonly<{
    state: 'processed';
    recipient: PartyRefV1;
    messageId: EntityId;
    receiptId: EntityId;
  }>
  | Readonly<{
    state: 'retry_scheduled';
    recipient: PartyRefV1;
    messageId: EntityId;
    receiptId: EntityId;
    retryCount: number;
    nextAttemptAt: string;
    error: string;
  }>
  | Readonly<{
    state: 'failed';
    recipient: PartyRefV1;
    messageId: EntityId;
    receiptId: EntityId;
    retryCount: number;
    error: string;
  }>
  | Readonly<{
    state: 'stale';
    recipient: PartyRefV1;
    messageId: EntityId;
    receiptId: EntityId;
  }>
  | Readonly<{
    state: 'error';
    recipient: PartyRefV1;
    messageId: EntityId;
    receiptId: EntityId;
    error: string;
  }>
  | Readonly<{
    state: 'quarantined';
    candidateId: string;
    code: InvalidDueMessageReceiptCode | 'message_projection_invalid';
    projectId?: string;
    messageId?: string;
    receiptId?: string;
    error: string;
  }>;

export interface DrainResult {
  readonly consumerId: string;
  readonly scanned: number;
  readonly processed: number;
  readonly retryScheduled: number;
  readonly failed: number;
  readonly busy: number;
  readonly stale: number;
  readonly errors: number;
  readonly quarantined: number;
  readonly results: readonly ProcessResult[];
}

export interface DurableEffectExecutionContext {
  readonly externalIdempotencyKey: string;
}

export interface DurableEffectInput<T> {
  readonly projectId: EntityId;
  readonly taskId?: EntityId;
  readonly assignmentAttemptId?: EntityId;
  readonly causationId: EntityId;
  readonly stableEffectId: string;
  readonly effectType: string;
  readonly request: unknown;
  readonly replaySafety: EffectReplaySafety;
  readonly escalationContext?: EffectEscalationContextV1;
  readonly createdAt?: string;
  readonly execute: (context: DurableEffectExecutionContext) => Promise<T>;
  readonly serialize: (value: T) => JsonValue;
  readonly parse: (value: JsonValue) => T;
}

export interface EffectEscalationContextV1 {
  readonly sessionId: EntityId;
  readonly owningPmId: EntityId;
  readonly taskBriefId?: EntityId;
}

export interface EffectEscalationV1 {
  readonly contractVersion: 1;
  readonly projectId: EntityId;
  readonly taskId?: EntityId;
  readonly assignmentAttemptId?: EntityId;
  readonly sessionId: EntityId;
  readonly owningPmId: EntityId;
  readonly taskBriefId?: EntityId;
  readonly causationId: EntityId;
  readonly stableEffectId: string;
  readonly effectType: string;
  readonly reason: string;
  readonly createdAt: string;
}

export interface EffectEscalationPort {
  append(input: EffectEscalationV1): Promise<AgentMessageEnvelopeV1>;
}

export interface ReceiptEscalationV1 {
  readonly contractVersion: 1;
  readonly projectId: EntityId;
  readonly sessionId: EntityId;
  readonly taskId?: EntityId;
  readonly taskBriefId?: EntityId;
  readonly assignmentAttemptId?: EntityId;
  readonly owningPmId: EntityId;
  readonly causationId: EntityId;
  readonly receiptId: EntityId;
  readonly retryCount: number;
  readonly reasonCode: 'RECEIPT_TERMINAL_FAILURE';
  readonly createdAt: string;
}

export interface ReceiptEscalationPort {
  append(input: ReceiptEscalationV1): Promise<AgentMessageEnvelopeV1>;
}

export interface MessageDispatchPort {
  /** The port must honor the supplied stable external idempotency key when replay-safe. */
  readonly replaySafety: EffectReplaySafety;
  handle(
    envelope: AgentMessageEnvelopeV1,
    context: DurableEffectExecutionContext & Readonly<{
      recipient: PartyRefV1;
      receiptId: EntityId;
    }>,
  ): Promise<void>;
}
