import { z } from 'zod';
import {
  AGENT_ROLES,
  BROADCAST_SENTINEL,
  MESSAGE_KINDS,
  MESSAGE_PRIORITIES,
  PAYLOAD_PROVENANCE_CLASSES,
  SYSTEM_SENTINEL,
  USER_SENTINEL,
  type MessageKind,
} from './constants.js';
import { EntityIdSchema, OpaqueIdentifierSchema } from './identity.js';
import { StructuredVerdictV1Schema } from './policy.js';

const ISO_DATETIME_SCHEMA = z.iso.datetime({ offset: true });
const NON_EMPTY_TEXT_SCHEMA = z.string().trim().min(1);
const EVIDENCE_REFS_SCHEMA = z.array(NON_EMPTY_TEXT_SCHEMA).readonly();
const AGENT_ID_SCHEMA = EntityIdSchema;
const PRINCIPAL_ID_SCHEMA = z.union([
  AGENT_ID_SCHEMA,
  z.literal(USER_SENTINEL),
  z.literal(SYSTEM_SENTINEL),
]);

const AgentPartyRefV1Schema = z.strictObject({
  type: z.literal('agent'),
  id: AGENT_ID_SCHEMA,
});
const UserPartyRefV1Schema = z.strictObject({
  type: z.literal('user'),
  id: z.literal(USER_SENTINEL),
});
const SystemPartyRefV1Schema = z.strictObject({
  type: z.literal('system'),
  id: z.literal(SYSTEM_SENTINEL),
});
const BroadcastPartyRefV1Schema = z.strictObject({
  type: z.literal('broadcast'),
  id: z.literal(BROADCAST_SENTINEL),
});

export const PartyRefV1Schema = z.discriminatedUnion('type', [
  AgentPartyRefV1Schema,
  UserPartyRefV1Schema,
  SystemPartyRefV1Schema,
  BroadcastPartyRefV1Schema,
]).readonly();

export type PartyRefV1 = z.infer<typeof PartyRefV1Schema>;

const UserPrincipalV1Schema = z.strictObject({
  principalType: z.literal('user'),
  principalId: z.literal(USER_SENTINEL),
  authenticatedAt: ISO_DATETIME_SCHEMA,
});
const AgentPrincipalV1Schema = z.strictObject({
  principalType: z.literal('agent'),
  principalId: AGENT_ID_SCHEMA,
  role: z.enum(AGENT_ROLES),
  agentVersion: z.number().int().nonnegative(),
  authenticatedAt: ISO_DATETIME_SCHEMA,
});
const SystemPrincipalV1Schema = z.strictObject({
  principalType: z.literal('system'),
  principalId: z.literal(SYSTEM_SENTINEL),
  serviceName: NON_EMPTY_TEXT_SCHEMA,
  authenticatedAt: ISO_DATETIME_SCHEMA,
});

export const AuthenticatedPrincipalV1Schema = z.discriminatedUnion('principalType', [
  UserPrincipalV1Schema,
  AgentPrincipalV1Schema,
  SystemPrincipalV1Schema,
]).readonly();

export const AuthenticatedPrincipalSnapshotV1Schema = AuthenticatedPrincipalV1Schema;
export type AuthenticatedPrincipalV1 = z.infer<typeof AuthenticatedPrincipalV1Schema>;
export type AuthenticatedPrincipalSnapshotV1 = AuthenticatedPrincipalV1;

export const ProvenanceV1Schema = z.strictObject({
  class: z.enum(PAYLOAD_PROVENANCE_CLASSES),
  sourceId: OpaqueIdentifierSchema.optional(),
  sourceVersion: NON_EMPTY_TEXT_SCHEMA.optional(),
}).readonly();

export type ProvenanceV1 = z.infer<typeof ProvenanceV1Schema>;

const QuestionPayloadV1Schema = z.strictObject({
  type: z.literal('question'),
  text: NON_EMPTY_TEXT_SCHEMA,
});
const AnswerPayloadV1Schema = z.strictObject({
  type: z.literal('answer'),
  text: NON_EMPTY_TEXT_SCHEMA,
});
const OrderPayloadV1Schema = z.strictObject({
  type: z.literal('order'),
  instruction: NON_EMPTY_TEXT_SCHEMA,
});
const ProposalPayloadV1Schema = z.strictObject({
  type: z.literal('proposal'),
  markdown: NON_EMPTY_TEXT_SCHEMA,
});
const ObjectionPayloadV1Schema = z.strictObject({
  type: z.literal('objection'),
  markdown: NON_EMPTY_TEXT_SCHEMA,
  evidenceRefs: EVIDENCE_REFS_SCHEMA,
});
const SynthesisPayloadV1Schema = z.strictObject({
  type: z.literal('synthesis'),
  markdown: NON_EMPTY_TEXT_SCHEMA,
});
const ReportPayloadV1Schema = z.strictObject({
  type: z.literal('report'),
  summary: NON_EMPTY_TEXT_SCHEMA,
  evidenceRefs: EVIDENCE_REFS_SCHEMA,
});
const EscalationPayloadV1Schema = z.strictObject({
  type: z.literal('escalation'),
  reason: NON_EMPTY_TEXT_SCHEMA,
  evidenceRefs: EVIDENCE_REFS_SCHEMA,
});
const UserCommandPayloadV1Schema = z.strictObject({
  type: z.literal('user_command'),
  text: NON_EMPTY_TEXT_SCHEMA,
});
const VerdictPayloadV1Schema = z.strictObject({
  type: z.literal('verdict'),
  verdict: StructuredVerdictV1Schema,
});

export const MessagePayloadV1Schema = z.discriminatedUnion('type', [
  QuestionPayloadV1Schema,
  AnswerPayloadV1Schema,
  OrderPayloadV1Schema,
  ProposalPayloadV1Schema,
  ObjectionPayloadV1Schema,
  SynthesisPayloadV1Schema,
  ReportPayloadV1Schema,
  EscalationPayloadV1Schema,
  UserCommandPayloadV1Schema,
  VerdictPayloadV1Schema,
]).readonly();

export type MessagePayloadV1 = z.infer<typeof MessagePayloadV1Schema>;

interface MessageInvariantInput {
  kind: MessageKind;
  payload: MessagePayloadV1;
  taskId?: string | undefined;
  taskBriefId?: string | undefined;
  assignmentAttemptId?: string | undefined;
  replyToMessageId?: string | undefined;
  createdAt: string;
  deadlineAt?: string | undefined;
}

function addMessageInvariantIssues(
  value: MessageInvariantInput,
  ctx: z.RefinementCtx,
): void {
  if (value.kind !== value.payload.type) {
    ctx.addIssue({
      code: 'custom',
      path: ['payload', 'type'],
      message: 'kind ile payload.type aynı olmalıdır',
    });
  }
  if (value.kind === 'answer' && value.replyToMessageId === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['replyToMessageId'],
      message: 'answer tam olarak bir question mesajına bağlanmalıdır',
    });
  }
  if (
    (value.kind === 'report' || value.kind === 'verdict') &&
    (value.taskId === undefined ||
      value.taskBriefId === undefined ||
      value.assignmentAttemptId === undefined)
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['taskId'],
      message: 'report ve verdict task, brief ve assignment attempt kimliklerini taşımalıdır',
    });
  }
  if (
    value.deadlineAt !== undefined &&
    Date.parse(value.deadlineAt) <= Date.parse(value.createdAt)
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['deadlineAt'],
      message: 'deadlineAt createdAt değerinden sonra olmalıdır',
    });
  }
}

const AgentMessageEnvelopeV1BaseSchema = z.strictObject({
  protocolVersion: z.literal(1),
  messageId: EntityIdSchema,
  projectId: EntityIdSchema,
  sessionId: EntityIdSchema,
  taskId: EntityIdSchema.optional(),
  taskBriefId: EntityIdSchema.optional(),
  assignmentAttemptId: EntityIdSchema.optional(),
  senderPrincipalId: PRINCIPAL_ID_SCHEMA,
  authenticatedPrincipal: AuthenticatedPrincipalV1Schema,
  recipient: PartyRefV1Schema,
  kind: z.enum(MESSAGE_KINDS),
  payload: MessagePayloadV1Schema,
  replyToMessageId: EntityIdSchema.optional(),
  correlationId: EntityIdSchema,
  causationId: EntityIdSchema.optional(),
  idempotencyKey: NON_EMPTY_TEXT_SCHEMA,
  invocationId: EntityIdSchema.optional(),
  promptInputSnapshotId: EntityIdSchema.optional(),
  provenance: ProvenanceV1Schema,
  priority: z.enum(MESSAGE_PRIORITIES),
  createdAt: ISO_DATETIME_SCHEMA,
  deadlineAt: ISO_DATETIME_SCHEMA.optional(),
});

export const AgentMessageEnvelopeV1Schema = AgentMessageEnvelopeV1BaseSchema.superRefine(
  (value, ctx) => {
    addMessageInvariantIssues(value, ctx);
    if (value.senderPrincipalId !== value.authenticatedPrincipal.principalId) {
      ctx.addIssue({
        code: 'custom',
        path: ['senderPrincipalId'],
        message: 'senderPrincipalId doğrulanmış principal kimliğiyle eşleşmelidir',
      });
    }
    if (value.recipient.type === 'broadcast') {
      const canBroadcast =
        value.authenticatedPrincipal.principalType === 'system' ||
        (value.authenticatedPrincipal.principalType === 'agent' &&
          value.authenticatedPrincipal.role === 'pm');
      if (!canBroadcast) {
        ctx.addIssue({
          code: 'custom',
          path: ['recipient'],
          message: 'broadcast yalnız doğrulanmış PM veya sistem principal tarafından kullanılabilir',
        });
      }
    }
  },
).readonly();

export type AgentMessageEnvelopeV1 = z.infer<typeof AgentMessageEnvelopeV1Schema>;

const SendMessageInputV1BaseSchema = z.strictObject({
  projectId: EntityIdSchema,
  sessionId: EntityIdSchema,
  taskId: EntityIdSchema.optional(),
  taskBriefId: EntityIdSchema.optional(),
  assignmentAttemptId: EntityIdSchema.optional(),
  recipient: PartyRefV1Schema,
  kind: z.enum(MESSAGE_KINDS),
  payload: MessagePayloadV1Schema,
  replyToMessageId: EntityIdSchema.optional(),
  correlationId: EntityIdSchema.optional(),
  causationId: EntityIdSchema.optional(),
  idempotencyKey: NON_EMPTY_TEXT_SCHEMA,
  invocationId: EntityIdSchema.optional(),
  promptInputSnapshotId: EntityIdSchema.optional(),
  provenance: ProvenanceV1Schema,
  priority: z.enum(MESSAGE_PRIORITIES),
  createdAt: ISO_DATETIME_SCHEMA,
  deadlineAt: ISO_DATETIME_SCHEMA.optional(),
});

export const SendMessageInputV1Schema = SendMessageInputV1BaseSchema.superRefine(
  addMessageInvariantIssues,
).readonly();

export type SendMessageInputV1 = z.infer<typeof SendMessageInputV1Schema>;

export function parseAgentMessageEnvelopeV1(input: unknown): AgentMessageEnvelopeV1 {
  return AgentMessageEnvelopeV1Schema.parse(input);
}
