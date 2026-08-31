// Denetim bulgusu girdisi (docs/03 standart denetçileri, docs/08 denetim ekranı).
//
// NEDEN VAR: denetim ekranı ve `audit_findings` deposu vardı ama HİÇBİR üretim
// yolu bulgu YARATMIYORDU: ekran kalıcı olarak boştu. Boş bir denetim ekranı
// "ihlal yok" der — oysa denetim hiç çalışmamıştır. Bu ikisi aynı şey değildir.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AUDIT_FINDING_PROFILES, AUDIT_FINDING_SEVERITIES, AUDIT_FINDING_STATUSES,
  EntityIdSchema, POLICY_RULE_IDS,
} from '@ww/shared';

const FindingInput = z.strictObject({
  profile: z.enum(AUDIT_FINDING_PROFILES),
  severity: z.enum(AUDIT_FINDING_SEVERITIES),
  summary: z.string().trim().min(1),
  evidenceRefs: z.array(z.string().trim().min(1)).min(1),
  ruleId: z.enum(POLICY_RULE_IDS),
  ruleVersion: z.number().int().positive().default(1),
  taskId: EntityIdSchema.optional(),
  messageId: EntityIdSchema.optional(),
  status: z.enum(AUDIT_FINDING_STATUSES).default('open'),
  correctiveTaskId: EntityIdSchema.optional(),
});

export type FindingInputValue = z.infer<typeof FindingInput>;

export const parseFindingInput = (value: unknown): FindingInputValue => FindingInput.parse(value);

export function buildAuditFinding(
  projectId: string,
  input: FindingInputValue,
  now: string,
): Record<string, unknown> {
  return {
    findingId: randomUUID(),
    projectId,
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
    profile: input.profile,
    rule: { ruleId: input.ruleId, ruleVersion: input.ruleVersion },
    severity: input.severity,
    summary: input.summary,
    evidenceRefs: [...input.evidenceRefs],
    status: input.status,
    ...(input.correctiveTaskId === undefined ? {} : { correctiveTaskId: input.correctiveTaskId }),
    createdAt: now,
  };
}
