import {
  EntityIdSchema,
  SYSTEM_SENTINEL,
  canonicalSha256V1,
  type AssignmentAttemptV1,
  type AuthenticatedPrincipalV1,
  type EntityId,
  type PolicyDecision,
  type TaskBriefV1,
  type TaskCausalCursorV1,
  type TaskHandoffV1,
  type TaskStatus,
  type VersionedRuleRefV1,
} from '@ww/shared';
import type { AgentRow, TaskRow } from '@ww/db';
import type { SchedulerErrorCode } from './errors.js';

export interface TaskStateV1 {
  readonly projectId: EntityId;
  readonly taskId: EntityId;
  readonly taskVersion: string;
  readonly status: TaskStatus;
  readonly taskBriefId?: EntityId;
  readonly assignmentAttemptId?: EntityId;
  readonly workerAgentId?: EntityId;
  readonly verifierAgentId?: EntityId;
  readonly attempt: number;
  readonly transitionId: EntityId;
  readonly decision: PolicyDecision;
}

export interface AppendTaskCausalEntryInput {
  readonly projectId: EntityId;
  readonly taskId: EntityId;
  readonly taskBriefId: EntityId;
  readonly assignmentAttemptId: EntityId;
  readonly handoffId?: EntityId;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly causationId?: EntityId;
  readonly createdAt: string;
}

export interface SealTaskBriefInput {
  readonly taskId: EntityId;
  readonly planId?: EntityId;
  readonly workerPrompt: PromptBinding;
  readonly verifierPrompt: PromptBinding;
  readonly acceptanceCriteria?: readonly string[];
  readonly allowedTools?: readonly string[];
  readonly ruleRefs?: readonly VersionedRuleRefV1[];
  readonly standardKnowledgeIds?: readonly EntityId[];
  readonly requirementKnowledgeIds?: readonly EntityId[];
  readonly baseContextCutoffAt?: string;
  readonly rebase?: boolean;
}

export interface PromptBinding {
  readonly name: string;
  readonly version: number;
}

export interface TaskBriefPolicyInput {
  readonly task: TaskRow;
  readonly worker: AgentRow;
  readonly verifier: AgentRow;
}

export interface TaskBriefPolicy {
  readonly acceptanceCriteria: readonly string[];
  readonly allowedTools: readonly string[];
  readonly ruleRefs: readonly VersionedRuleRefV1[];
  readonly standardKnowledgeIds: readonly EntityId[];
  readonly requirementKnowledgeIds: readonly EntityId[];
}

export interface TaskBriefPolicyPort {
  resolve(input: TaskBriefPolicyInput): Promise<TaskBriefPolicy> | TaskBriefPolicy;
}

export interface HandoffContext {
  readonly artifactIds: readonly EntityId[];
  readonly evidenceRefs: readonly string[];
  readonly pendingQuestionMessageIds: readonly EntityId[];
  readonly pendingReceiptIds: readonly EntityId[];
  readonly workspaceCheckpoint: {
    readonly commitHash?: string;
    readonly changedPaths: readonly string[];
  };
}

export interface HandoffContextPort {
  load(task: TaskRow, attempt: AssignmentAttemptV1): Promise<HandoffContext>;
}

export interface ReassignTaskInput {
  readonly taskId: EntityId;
  readonly requestedAt: string;
  readonly causationId: EntityId;
}

export interface RebaseTaskInput extends ReassignTaskInput {
  readonly planId?: EntityId;
  readonly acceptanceCriteria?: readonly string[];
  readonly allowedTools?: readonly string[];
  readonly ruleRefs?: readonly VersionedRuleRefV1[];
  readonly standardKnowledgeIds?: readonly EntityId[];
  readonly requirementKnowledgeIds?: readonly EntityId[];
}

export interface AssignmentResult {
  readonly attempt: AssignmentAttemptV1;
  readonly brief: TaskBriefV1;
  readonly causalCursor: TaskCausalCursorV1;
  readonly handoff?: TaskHandoffV1;
}

export interface AssignmentRunnerPort {
  assign(taskId: string): Promise<AssignmentAttemptV1>;
}

export interface AssignmentServiceFactoryPort {
  forProject(projectId: EntityId, consumerId: string): AssignmentRunnerPort;
}

export type RunOnceItemState = 'assigned' | 'recovered' | 'deferred' | 'failed';

export interface RunOnceItemResult {
  readonly msgId: string;
  readonly taskId: EntityId;
  readonly source: 'new' | 'reclaimed';
  readonly deliveryCount: number;
  readonly state: RunOnceItemState;
  readonly assignmentAttemptId?: EntityId;
  readonly error?: string;
  readonly errorCode?: SchedulerErrorCode;
}

export interface RunOnceResult {
  readonly projectId: EntityId;
  readonly consumerId: string;
  readonly items: readonly RunOnceItemResult[];
  readonly invalidMessageIds: readonly string[];
  readonly exhaustedMessageIds: readonly string[];
  readonly deletedMessageIds: readonly string[];
  readonly nextReclaimCursor: string;
}

export interface ClockPort {
  now(): string;
}

export const systemClock: ClockPort = Object.freeze({
  now: () => new Date().toISOString(),
});

const TASK_RULE_TEXT_V1 = Object.freeze({
  'TASK-001': 'Only the documented task finite-state-machine edge may run.',
  'TASK-002': 'The authenticated principal must own the requested transition action.',
  'TASK-003': 'Project, task brief, assignment attempt, and current state must match.',
  'TASK-004': 'Attempt limits, deterministic replay identity, and fencing fail closed.',
} as const);

export const DEFAULT_TASK_RULE_REFS_V1: readonly VersionedRuleRefV1[] = Object.freeze(
  Object.entries(TASK_RULE_TEXT_V1).map(([ruleId, text]) => Object.freeze({
    ruleId: ruleId as keyof typeof TASK_RULE_TEXT_V1,
    ruleVersion: 1,
    hash: canonicalSha256V1({ ruleId, ruleVersion: 1, text }),
  })),
);

export function deterministicSchedulerEntityId(namespace: string, value: unknown): EntityId {
  const hex = canonicalSha256V1({ namespace, value });
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return EntityIdSchema.parse(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`,
  );
}

export function systemPrincipal(serviceName: string, authenticatedAt: string): AuthenticatedPrincipalV1 {
  return Object.freeze({
    principalType: 'system',
    principalId: SYSTEM_SENTINEL,
    serviceName,
    authenticatedAt,
  });
}
