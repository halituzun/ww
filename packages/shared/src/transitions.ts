import { z } from 'zod';
import { TASK_STATUSES } from './constants.js';
import { EntityIdSchema } from './identity.js';

const ISO_DATETIME_SCHEMA = z.iso.datetime({ offset: true });
const NON_EMPTY_TEXT_SCHEMA = z.string().trim().min(1);
const EVIDENCE_REFS_SCHEMA = z.array(NON_EMPTY_TEXT_SCHEMA).readonly();

export const TASK_TRANSITION_ACTIONS = [
  'assign',
  'start_work',
  'report_result',
  'verifier_approved',
  'verifier_rejected',
  'gate_passed',
  'gate_failed',
  'commit_completed',
  'escalate',
  'escalation_resolved',
  'request_user_input',
  'user_answered',
  'cancel',
  'fail',
] as const;

const TransitionIdentityShape = {
  protocolVersion: z.literal(1),
  transitionRequestId: EntityIdSchema,
  projectId: EntityIdSchema,
  taskId: EntityIdSchema,
  causationId: EntityIdSchema,
  requestedAt: ISO_DATETIME_SCHEMA,
};

const CommonTransitionShape = {
  ...TransitionIdentityShape,
  taskBriefId: EntityIdSchema,
};

const AttemptScopedTransitionShape = {
  ...CommonTransitionShape,
  assignmentAttemptId: EntityIdSchema,
};

const NoDetailAttemptTransitionSchema = (
  action: 'start_work' | 'gate_passed' | 'escalation_resolved' | 'user_answered',
) => z.strictObject({ ...AttemptScopedTransitionShape, action: z.literal(action) });

const SemanticTransitionRequestV1Schema = z.discriminatedUnion('action', [
  z.strictObject({
    ...CommonTransitionShape,
    action: z.literal('assign'),
    workerAgentId: EntityIdSchema,
    verifierAgentId: EntityIdSchema,
  }),
  NoDetailAttemptTransitionSchema('start_work'),
  z.strictObject({
    ...AttemptScopedTransitionShape,
    action: z.literal('report_result'),
    resultSummary: NON_EMPTY_TEXT_SCHEMA,
    evidenceRefs: EVIDENCE_REFS_SCHEMA,
  }),
  z.strictObject({
    ...AttemptScopedTransitionShape,
    action: z.literal('verifier_approved'),
    verdictMessageId: EntityIdSchema,
  }),
  z.strictObject({
    ...AttemptScopedTransitionShape,
    action: z.literal('verifier_rejected'),
    verdictMessageId: EntityIdSchema,
    reason: NON_EMPTY_TEXT_SCHEMA,
  }),
  NoDetailAttemptTransitionSchema('gate_passed'),
  z.strictObject({
    ...AttemptScopedTransitionShape,
    action: z.literal('gate_failed'),
    reason: NON_EMPTY_TEXT_SCHEMA,
    evidenceRefs: EVIDENCE_REFS_SCHEMA,
  }),
  z.strictObject({
    ...AttemptScopedTransitionShape,
    action: z.literal('commit_completed'),
    commitHash: z.string().regex(/^[a-f0-9]{7,64}$/),
    artifactIds: z.array(EntityIdSchema).readonly(),
  }),
  z.strictObject({
    ...AttemptScopedTransitionShape,
    action: z.literal('escalate'),
    reason: NON_EMPTY_TEXT_SCHEMA,
    evidenceRefs: EVIDENCE_REFS_SCHEMA,
  }),
  NoDetailAttemptTransitionSchema('escalation_resolved'),
  z.strictObject({
    ...AttemptScopedTransitionShape,
    action: z.literal('request_user_input'),
    questionMessageId: EntityIdSchema,
  }),
  NoDetailAttemptTransitionSchema('user_answered'),
  z.strictObject({
    ...AttemptScopedTransitionShape,
    action: z.literal('fail'),
    reason: NON_EMPTY_TEXT_SCHEMA,
  }),
]);

// Shared validates transport shape only; legal/current FSM edges belong to scheduler Phase 4.
const AttemptScopedCancelTransitionSchema = z.strictObject({
  ...AttemptScopedTransitionShape,
  action: z.literal('cancel'),
  fromStatus: z.enum(TASK_STATUSES),
  reason: NON_EMPTY_TEXT_SCHEMA,
});

const CancelTransitionRequestV1Schema = z.union([
  z.strictObject({
    ...TransitionIdentityShape,
    action: z.literal('cancel'),
    fromStatus: z.enum(TASK_STATUSES),
    reason: NON_EMPTY_TEXT_SCHEMA,
  }),
  AttemptScopedCancelTransitionSchema,
]);

export const TaskTransitionRequestV1Schema = z.union([
  SemanticTransitionRequestV1Schema,
  CancelTransitionRequestV1Schema,
]).readonly();

export type TaskTransitionActionV1 = (typeof TASK_TRANSITION_ACTIONS)[number];
export type TaskTransitionRequestV1 = z.infer<typeof TaskTransitionRequestV1Schema>;
