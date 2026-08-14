import { z } from 'zod';
import {
  AGENT_ROLES,
  POLICY_RULE_IDS,
  TASK_STATUSES,
} from './constants.js';
import { EntityIdSchema } from './identity.js';

const ISO_DATETIME_SCHEMA = z.iso.datetime({ offset: true });
const NON_EMPTY_TEXT_SCHEMA = z.string().trim().min(1);
const EVIDENCE_REFS_SCHEMA = z.array(NON_EMPTY_TEXT_SCHEMA).readonly();

export const PolicyRuleIdSchema = z.enum(POLICY_RULE_IDS);

export const RuleRefV1Schema = z.strictObject({
  ruleId: PolicyRuleIdSchema,
  ruleVersion: z.number().int().positive(),
}).readonly();

export type RuleRefV1 = z.infer<typeof RuleRefV1Schema>;

export const PolicyDecisionSchema = z.strictObject({
  ruleId: PolicyRuleIdSchema,
  ruleVersion: z.number().int().positive(),
  allowed: z.boolean(),
  reason: NON_EMPTY_TEXT_SCHEMA,
  evidenceRefs: EVIDENCE_REFS_SCHEMA,
}).readonly();

export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

export const VerdictReasonV1Schema = z.strictObject({
  message: NON_EMPTY_TEXT_SCHEMA,
  evidenceRefs: EVIDENCE_REFS_SCHEMA,
  rule: RuleRefV1Schema.optional(),
}).readonly();

export const StructuredVerdictV1Schema = z.strictObject({
  decision: z.enum(['approve', 'reject']),
  reasons: z.array(VerdictReasonV1Schema).min(1).readonly(),
  evidenceRefs: EVIDENCE_REFS_SCHEMA,
  ruleRefs: z.array(RuleRefV1Schema).min(1).readonly(),
}).readonly();

export type StructuredVerdictV1 = z.infer<typeof StructuredVerdictV1Schema>;

export const AUDIT_FINDING_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export const AUDIT_FINDING_STATUSES = [
  'open', 'correction_pending', 'resolved', 'dismissed',
] as const;
export const AUDIT_FINDING_PROFILES = ['verifier', 'communication_audit'] as const;

const AuditFindingBaseSchema = z.strictObject({
  findingId: EntityIdSchema,
  projectId: EntityIdSchema,
  taskId: EntityIdSchema.optional(),
  messageId: EntityIdSchema.optional(),
  profile: z.enum(AUDIT_FINDING_PROFILES),
  rule: RuleRefV1Schema,
  severity: z.enum(AUDIT_FINDING_SEVERITIES),
  summary: NON_EMPTY_TEXT_SCHEMA,
  evidenceRefs: EVIDENCE_REFS_SCHEMA,
  status: z.enum(AUDIT_FINDING_STATUSES),
  correctiveTaskId: EntityIdSchema.optional(),
  resolution: NON_EMPTY_TEXT_SCHEMA.optional(),
  createdAt: ISO_DATETIME_SCHEMA,
});

export const AuditFindingSchema = AuditFindingBaseSchema.superRefine((finding, ctx) => {
  if (finding.status === 'correction_pending' && finding.correctiveTaskId === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['correctiveTaskId'],
      message: 'correction_pending bulgusu bir düzeltme görevine bağlanmalıdır',
    });
  }
  if (finding.status === 'resolved' && finding.resolution === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['resolution'],
      message: 'resolved bulgusu çözüm açıklaması taşımalıdır',
    });
  }
}).readonly();

export type AuditFinding = z.infer<typeof AuditFindingSchema>;

export const TOOL_REPLAY_SAFETY = ['replay_safe', 'non_replay_safe'] as const;

export const ToolCapabilityV1Schema = z.strictObject({
  toolName: NON_EMPTY_TEXT_SCHEMA,
  rule: RuleRefV1Schema,
  allowedRoles: z.array(z.enum(AGENT_ROLES)).min(1).readonly(),
  allowedTaskStatuses: z.array(z.enum(TASK_STATUSES)).min(1).readonly(),
  requiresDeclaredTarget: z.boolean(),
  requiresFileLock: z.boolean(),
  replaySafety: z.enum(TOOL_REPLAY_SAFETY),
}).readonly();

export type ToolCapabilityV1 = z.infer<typeof ToolCapabilityV1Schema>;
