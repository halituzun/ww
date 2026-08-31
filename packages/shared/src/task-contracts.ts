import { z } from 'zod';
import {
  JsonValueSchema,
  canonicalSha256V1,
  type JsonObject,
} from './json.js';
import { EntityIdSchema, OpaqueIdentifierSchema } from './identity.js';
import { PolicyRuleIdSchema } from './policy.js';

const ISO_DATETIME_SCHEMA = z.iso.datetime({ offset: true });
const NON_EMPTY_TEXT_SCHEMA = z.string().trim().min(1);
const SHA256_SCHEMA = z.string().regex(/^[a-f0-9]{64}$/, 'SHA-256 küçük harfli hex olmalıdır');
const GIT_HASH_SCHEMA = z.string().regex(/^[a-f0-9]{7,64}$/, 'geçerli bir git hash gereklidir');

export const SOURCE_MANIFEST_TYPES = [
  'task', 'plan', 'prompt', 'rule', 'standard', 'requirement', 'knowledge', 'summary',
  'project_map',
] as const;

export type SourceManifestType = (typeof SOURCE_MANIFEST_TYPES)[number];

export const VersionedSourceRefV1Schema = z.strictObject({
  sourceType: z.enum(SOURCE_MANIFEST_TYPES),
  sourceId: OpaqueIdentifierSchema,
  version: z.number().int().nonnegative(),
  hash: SHA256_SCHEMA,
}).readonly();

export type VersionedSourceRefV1 = z.infer<typeof VersionedSourceRefV1Schema>;

export const SourceVersionManifestV1Schema = z.array(VersionedSourceRefV1Schema)
  .min(1)
  .superRefine((manifest, ctx) => {
    const identities = new Set<string>();
    for (const [index, source] of manifest.entries()) {
      const identity = JSON.stringify([source.sourceType, source.sourceId, source.version]);
      if (identities.has(identity)) {
        ctx.addIssue({
          code: 'custom',
          path: [index],
          message: 'source-version manifest kaynak kimlikleri tekil olmalıdır',
        });
      }
      identities.add(identity);
    }
  })
  .readonly();

export type SourceVersionManifestV1 = z.infer<typeof SourceVersionManifestV1Schema>;

export const VersionedRuleRefV1Schema = z.strictObject({
  ruleId: PolicyRuleIdSchema,
  ruleVersion: z.number().int().positive(),
  hash: SHA256_SCHEMA,
}).readonly();

export type VersionedRuleRefV1 = z.infer<typeof VersionedRuleRefV1Schema>;

const TaskBriefV1BaseSchema = z.strictObject({
  contractVersion: z.literal(1),
  taskBriefId: EntityIdSchema,
  taskBriefVersion: z.number().int().positive(),
  projectId: EntityIdSchema,
  taskId: EntityIdSchema,
  taskVersion: z.number().int().nonnegative(),
  planId: EntityIdSchema,
  planVersion: z.number().int().positive(),
  planHash: SHA256_SCHEMA,
  goal: NON_EMPTY_TEXT_SCHEMA,
  acceptanceCriteria: z.array(NON_EMPTY_TEXT_SCHEMA).min(1).readonly(),
  dependencyTaskIds: z.array(EntityIdSchema).readonly(),
  targetFiles: z.array(NON_EMPTY_TEXT_SCHEMA).readonly(),
  allowedTools: z.array(NON_EMPTY_TEXT_SCHEMA).readonly(),
  tokenBudget: z.number().int().nonnegative(),
  deadlineAt: ISO_DATETIME_SCHEMA.optional(),
  promptRefs: z.array(VersionedSourceRefV1Schema).min(1).readonly(),
  ruleRefs: z.array(VersionedRuleRefV1Schema).min(1).readonly(),
  standardRefs: z.array(VersionedSourceRefV1Schema).readonly(),
  contextSnapshotId: EntityIdSchema,
  baseContextCutoffAt: ISO_DATETIME_SCHEMA,
  sourceVersionManifest: SourceVersionManifestV1Schema,
  verificationMode: z.enum(['required', 'exempt']),
  verificationExemptionRule: VersionedRuleRefV1Schema.optional(),
  sealedAt: ISO_DATETIME_SCHEMA,
});

export const TaskBriefV1Schema = TaskBriefV1BaseSchema.superRefine((brief, ctx) => {
  const requireManifestRef = (
    ref: VersionedSourceRefV1,
    path: PropertyKey[],
  ): void => {
    const present = brief.sourceVersionManifest.some((item) =>
      item.sourceType === ref.sourceType &&
      item.sourceId === ref.sourceId &&
      item.version === ref.version &&
      item.hash === ref.hash);
    if (!present) {
      ctx.addIssue({
        code: 'custom',
        path,
        message: `${ref.sourceType} kaynağı sourceVersionManifest içinde birebir bulunmalıdır`,
      });
    }
  };

  requireManifestRef({
    sourceType: 'plan',
    sourceId: brief.planId,
    version: brief.planVersion,
    hash: brief.planHash,
  }, ['sourceVersionManifest']);
  for (const [index, ref] of brief.promptRefs.entries()) {
    if (ref.sourceType !== 'prompt') {
      ctx.addIssue({
        code: 'custom',
        path: ['promptRefs', index, 'sourceType'],
        message: 'promptRefs yalnız prompt kaynaklarını içerebilir',
      });
    }
    requireManifestRef({ ...ref, sourceType: 'prompt' }, ['promptRefs', index]);
  }
  for (const [index, ref] of brief.ruleRefs.entries()) {
    requireManifestRef({
      sourceType: 'rule',
      sourceId: ref.ruleId,
      version: ref.ruleVersion,
      hash: ref.hash,
    }, ['ruleRefs', index]);
  }
  if (brief.verificationExemptionRule !== undefined) {
    requireManifestRef({
      sourceType: 'rule',
      sourceId: brief.verificationExemptionRule.ruleId,
      version: brief.verificationExemptionRule.ruleVersion,
      hash: brief.verificationExemptionRule.hash,
    }, ['verificationExemptionRule']);
  }
  for (const [index, ref] of brief.standardRefs.entries()) {
    if (ref.sourceType !== 'standard') {
      ctx.addIssue({
        code: 'custom',
        path: ['standardRefs', index, 'sourceType'],
        message: 'standardRefs yalnız standard kaynaklarını içerebilir',
      });
    }
    requireManifestRef({ ...ref, sourceType: 'standard' }, ['standardRefs', index]);
  }

  if (
    brief.verificationMode === 'exempt' &&
    brief.verificationExemptionRule === undefined
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['verificationExemptionRule'],
      message: 'exempt doğrulama modu açık bir istisna kuralı gerektirir',
    });
  }
  if (
    brief.verificationMode === 'required' &&
    brief.verificationExemptionRule !== undefined
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['verificationExemptionRule'],
      message: 'required doğrulama modu istisna kuralı taşıyamaz',
    });
  }
  if (Date.parse(brief.baseContextCutoffAt) > Date.parse(brief.sealedAt)) {
    ctx.addIssue({
      code: 'custom',
      path: ['baseContextCutoffAt'],
      message: 'base context cutoff brief mühürlenmesinden sonra olamaz',
    });
  }
  if (brief.deadlineAt !== undefined && Date.parse(brief.deadlineAt) <= Date.parse(brief.sealedAt)) {
    ctx.addIssue({
      code: 'custom',
      path: ['deadlineAt'],
      message: 'deadline brief mühürlenmesinden sonra olmalıdır',
    });
  }
}).readonly();

export type TaskBriefV1 = z.infer<typeof TaskBriefV1Schema>;

export const ASSIGNMENT_START_REASONS = [
  'initial', 'retry_after_rejection', 'retry_after_gate_failure', 'reassignment', 'rebase',
] as const;

const AssignmentAttemptV1BaseSchema = z.strictObject({
  contractVersion: z.literal(1),
  assignmentAttemptId: EntityIdSchema,
  projectId: EntityIdSchema,
  taskId: EntityIdSchema,
  taskBriefId: EntityIdSchema,
  attemptNumber: z.number().int().positive(),
  workerAgentId: EntityIdSchema,
  verifierAgentId: EntityIdSchema,
  leaseOwner: NON_EMPTY_TEXT_SCHEMA,
  leaseFence: z.number().int().positive(),
  leaseExpiresAt: ISO_DATETIME_SCHEMA,
  startReason: z.enum(ASSIGNMENT_START_REASONS),
  previousAttemptId: EntityIdSchema.optional(),
  handoffId: EntityIdSchema.optional(),
  assignedAt: ISO_DATETIME_SCHEMA,
});

export const AssignmentAttemptV1Schema = AssignmentAttemptV1BaseSchema.superRefine(
  (attempt, ctx) => {
    if (attempt.workerAgentId === attempt.verifierAgentId) {
      ctx.addIssue({
        code: 'custom',
        path: ['verifierAgentId'],
        message: 'worker ve verifier bağımsız agentlar olmalıdır',
      });
    }
    if (attempt.startReason === 'initial' && attempt.previousAttemptId !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['previousAttemptId'],
        message: 'initial attempt önceki attempt taşıyamaz',
      });
    }
    if (attempt.startReason !== 'initial' && attempt.previousAttemptId === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['previousAttemptId'],
        message: 'retry, reassignment ve rebase önceki attempt kimliğini taşımalıdır',
      });
    }
    if (attempt.previousAttemptId === attempt.assignmentAttemptId) {
      ctx.addIssue({
        code: 'custom',
        path: ['previousAttemptId'],
        message: 'önceki attempt kimliği yeni attempt kimliğinden farklı olmalıdır',
      });
    }
    if (attempt.startReason === 'reassignment' && attempt.handoffId === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['handoffId'],
        message: 'reassignment typed handoff gerektirir',
      });
    }
    if (Date.parse(attempt.leaseExpiresAt) <= Date.parse(attempt.assignedAt)) {
      ctx.addIssue({
        code: 'custom',
        path: ['leaseExpiresAt'],
        message: 'lease atama zamanından sonra sona ermelidir',
      });
    }
  },
).readonly();

export type AssignmentAttemptV1 = z.infer<typeof AssignmentAttemptV1Schema>;

export const TaskCausalCursorV1Schema = z.strictObject({
  assignmentAttemptId: EntityIdSchema,
  handoffId: EntityIdSchema.optional(),
  ordinal: z.number().int().nonnegative(),
}).readonly();

export type TaskCausalCursorV1 = z.infer<typeof TaskCausalCursorV1Schema>;

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const PromptToolArgsV1Schema = JsonValueSchema.transform((value, ctx): JsonObject => {
  if (!isJsonObject(value)) {
    ctx.addIssue({
      code: 'custom',
      message: 'tool args bir JSON nesnesi olmalıdır',
    });
    return z.NEVER;
  }
  return value;
});

export const PromptToolCallV1Schema = z.strictObject({
  id: OpaqueIdentifierSchema,
  name: NON_EMPTY_TEXT_SCHEMA,
  args: PromptToolArgsV1Schema,
}).readonly();

export type PromptToolCallV1 = z.infer<typeof PromptToolCallV1Schema>;


export const PromptMessageV1Schema = z.discriminatedUnion('role', [
  z.strictObject({ role: z.literal('system'), content: z.string() }),
  z.strictObject({ role: z.literal('user'), content: z.string() }),
  z.strictObject({
    role: z.literal('assistant'),
    content: z.string(),
    toolCalls: z.array(PromptToolCallV1Schema).readonly().optional(),
  }),
  z.strictObject({
    role: z.literal('tool'),
    content: z.string(),
    toolCallId: OpaqueIdentifierSchema,
  }),
]).readonly();

export type PromptMessageV1 = z.infer<typeof PromptMessageV1Schema>;

const PromptInputSnapshotV1BaseSchema = z.strictObject({
  contractVersion: z.literal(1),
  promptInputSnapshotId: EntityIdSchema,
  invocationId: EntityIdSchema,
  projectId: EntityIdSchema,
  taskId: EntityIdSchema,
  taskBriefId: EntityIdSchema,
  assignmentAttemptId: EntityIdSchema,
  inputTaskCausalCursor: TaskCausalCursorV1Schema,
  sourceVersionManifest: SourceVersionManifestV1Schema,
  promptMessages: z.array(PromptMessageV1Schema).min(1).readonly(),
  promptHash: SHA256_SCHEMA,
  sealedAt: ISO_DATETIME_SCHEMA,
});

export const PromptInputSnapshotV1Schema = PromptInputSnapshotV1BaseSchema.superRefine(
  (snapshot, ctx) => {
    if (snapshot.inputTaskCausalCursor.assignmentAttemptId !== snapshot.assignmentAttemptId) {
      ctx.addIssue({
        code: 'custom',
        path: ['inputTaskCausalCursor', 'assignmentAttemptId'],
        message: 'input causal cursor aynı assignment attempt içinde olmalıdır',
      });
    }
    if (snapshot.promptHash !== canonicalSha256V1(snapshot.promptMessages)) {
      ctx.addIssue({
        code: 'custom',
        path: ['promptHash'],
        message: 'promptHash mühürlenen prompt mesajlarıyla eşleşmelidir',
      });
    }
  },
).readonly();

export type PromptInputSnapshotV1 = z.infer<typeof PromptInputSnapshotV1Schema>;

const WorkspaceCheckpointV1Schema = z.strictObject({
  commitHash: GIT_HASH_SCHEMA.optional(),
  changedPaths: z.array(NON_EMPTY_TEXT_SCHEMA).readonly(),
}).readonly();

const LockReleaseResultV1Schema = z.strictObject({
  releasedLockKeys: z.array(NON_EMPTY_TEXT_SCHEMA).readonly(),
  failedLockKeys: z.array(NON_EMPTY_TEXT_SCHEMA).readonly(),
}).superRefine((result, ctx) => {
  const released = new Set(result.releasedLockKeys);
  if (released.size !== result.releasedLockKeys.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['releasedLockKeys'],
      message: 'released lock anahtarları tekil olmalıdır',
    });
  }
  const failed = new Set(result.failedLockKeys);
  if (failed.size !== result.failedLockKeys.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['failedLockKeys'],
      message: 'failed lock anahtarları tekil olmalıdır',
    });
  }
  for (const [index, key] of result.failedLockKeys.entries()) {
    if (released.has(key)) {
      ctx.addIssue({
        code: 'custom',
        path: ['failedLockKeys', index],
        message: 'bir lock aynı anda released ve failed olamaz',
      });
    }
  }
}).readonly();

const LeaseReleaseResultV1Schema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('released'),
    leaseOwner: NON_EMPTY_TEXT_SCHEMA,
    leaseFence: z.number().int().positive(),
  }),
  z.strictObject({
    status: z.literal('failed'),
    leaseOwner: NON_EMPTY_TEXT_SCHEMA,
    leaseFence: z.number().int().positive(),
    error: NON_EMPTY_TEXT_SCHEMA,
  }),
]).readonly();

const TaskHandoffV1BaseSchema = z.strictObject({
  contractVersion: z.literal(1),
  handoffId: EntityIdSchema,
  projectId: EntityIdSchema,
  taskId: EntityIdSchema,
  taskBriefId: EntityIdSchema,
  fromAssignmentAttemptId: EntityIdSchema,
  toAssignmentAttemptId: EntityIdSchema,
  ancestorCursor: TaskCausalCursorV1Schema,
  artifactIds: z.array(EntityIdSchema).readonly(),
  evidenceRefs: z.array(NON_EMPTY_TEXT_SCHEMA).readonly(),
  pendingQuestionMessageIds: z.array(EntityIdSchema).readonly(),
  pendingReceiptIds: z.array(EntityIdSchema).readonly(),
  workspaceCheckpoint: WorkspaceCheckpointV1Schema,
  leaseRelease: LeaseReleaseResultV1Schema,
  lockRelease: LockReleaseResultV1Schema,
  createdAt: ISO_DATETIME_SCHEMA,
});

export const TaskHandoffV1Schema = TaskHandoffV1BaseSchema.superRefine((handoff, ctx) => {
  if (handoff.fromAssignmentAttemptId === handoff.toAssignmentAttemptId) {
    ctx.addIssue({
      code: 'custom',
      path: ['toAssignmentAttemptId'],
      message: 'handoff yeni bir assignment attempt üretmelidir',
    });
  }
  if (handoff.ancestorCursor.assignmentAttemptId !== handoff.fromAssignmentAttemptId) {
    ctx.addIssue({
      code: 'custom',
      path: ['ancestorCursor', 'assignmentAttemptId'],
      message: 'handoff cursor önceki attempt zincirini mühürlemelidir',
    });
  }
}).readonly();

export type TaskHandoffV1 = z.infer<typeof TaskHandoffV1Schema>;
