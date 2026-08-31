import { describe, expect, it } from 'vitest';
import { NIL_UUID } from './constants.js';
import {
  AuditFindingSchema,
  PolicyDecisionSchema,
  StructuredVerdictV1Schema,
  ToolCapabilityV1Schema,
} from './policy.js';

const ID = '11111111-1111-4111-8111-111111111111';

function validFinding(): Record<string, unknown> {
  return {
    findingId: ID,
    projectId: '22222222-2222-4222-8222-222222222222',
    profile: 'communication_audit',
    rule: { ruleId: 'COMM-004', ruleVersion: 1 },
    severity: 'high',
    summary: 'Yanıt yanlış soruya bağlı.',
    evidenceRefs: ['message:1'],
    status: 'open',
    createdAt: '2026-08-14T08:00:00.000Z',
  };
}

describe('policy contracts', () => {
  it('typed policy decision ve tool capability kabul eder', () => {
    expect(PolicyDecisionSchema.safeParse({
      ruleId: 'COMM-003',
      ruleVersion: 1,
      allowed: false,
      reason: 'worker verdict gönderemez',
      evidenceRefs: ['message:1'],
    }).success).toBe(true);
    expect(ToolCapabilityV1Schema.safeParse({
      toolName: 'write_file',
      rule: { ruleId: 'TOOL-001', ruleVersion: 1 },
      allowedRoles: ['worker'],
      allowedTaskStatuses: ['working'],
      requiresDeclaredTarget: true,
      requiresFileLock: true,
      replaySafety: 'replay_safe',
    }).success).toBe(true);
  });

  it('bilinmeyen kural ve serbest metin verdict reddedilir', () => {
    expect(PolicyDecisionSchema.safeParse({
      ruleId: 'COMM-999',
      ruleVersion: 1,
      allowed: true,
      reason: 'bilinmeyen',
      evidenceRefs: [],
    }).success).toBe(false);
    expect(StructuredVerdictV1Schema.safeParse({
      decision: 'reject',
      reasons: 'test yok',
      evidenceRefs: [],
      ruleRefs: [],
    }).success).toBe(false);
  });

  it('bulgu durumunun düzeltme ve çözüm alanlarını zorlar', () => {
    const base = validFinding();
    expect(AuditFindingSchema.safeParse({ ...base, status: 'correction_pending' }).success).toBe(false);
    expect(AuditFindingSchema.safeParse({ ...base, status: 'resolved' }).success).toBe(false);
    expect(AuditFindingSchema.safeParse({
      ...base,
      status: 'resolved',
      resolution: 'Doğru replyToMessageId ile yeniden gönderildi.',
    }).success).toBe(true);
    expect(AuditFindingSchema.safeParse({ ...base, status: 'open', extra: true }).success).toBe(false);
  });

  it.each([
    ['findingId', { ...validFinding(), findingId: NIL_UUID }],
    ['projectId', { ...validFinding(), projectId: NIL_UUID }],
    ['taskId', { ...validFinding(), taskId: NIL_UUID }],
    ['messageId', { ...validFinding(), messageId: NIL_UUID }],
    ['correctiveTaskId', {
      ...validFinding(),
      status: 'correction_pending',
      correctiveTaskId: NIL_UUID,
    }],
  ])('%s concrete kimliğinde nil UUID reddeder', (_field, finding) => {
    expect(AuditFindingSchema.safeParse(finding).success).toBe(false);
  });
});
