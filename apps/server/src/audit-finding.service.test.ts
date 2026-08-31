import { describe, expect, it } from 'vitest';
import { AuditFindingSchema, POLICY_RULE_IDS } from '@ww/shared';
import { buildAuditFinding, parseFindingInput } from './audit-finding.service.js';

const projectId = '00000000-0000-4000-8000-000000000001';
const base = {
  profile: 'verifier' as const,
  severity: 'medium' as const,
  summary: 'MVVM ihlali: View içinde fetch',
  evidenceRefs: ['file:src/App.tsx'],
  ruleId: POLICY_RULE_IDS[0],
};

describe('parseFindingInput', () => {
  it('geçerli bulguyu kabul eder', () => {
    expect(parseFindingInput(base).summary).toBe(base.summary);
  });

  // Kanıtsız bulgu, denetimi iddiaya indirger.
  it('kanıt zorunludur', () => {
    expect(() => parseFindingInput({ ...base, evidenceRefs: [] })).toThrow();
  });

  it('boş özeti reddeder', () => {
    expect(() => parseFindingInput({ ...base, summary: '  ' })).toThrow();
  });

  it('bilinmeyen profili reddeder', () => {
    expect(() => parseFindingInput({ ...base, profile: 'uydurma' })).toThrow();
  });
});

describe('buildAuditFinding', () => {
  const now = '2026-08-17T09:00:00.000Z';

  it('şemaya uyan bulgu üretir', () => {
    const finding = buildAuditFinding(projectId, parseFindingInput(base), now);
    expect(() => AuditFindingSchema.parse(finding)).not.toThrow();
  });

  it('her bulguya benzersiz kimlik verir', () => {
    const a = buildAuditFinding(projectId, parseFindingInput(base), now);
    const b = buildAuditFinding(projectId, parseFindingInput(base), now);
    expect(a['findingId']).not.toBe(b['findingId']);
  });

  // Şema: correction_pending durumu düzeltme görevi olmadan geçersizdir.
  it('düzeltme bekleyen bulgu görev kimliği ister', () => {
    const finding = buildAuditFinding(
      projectId,
      parseFindingInput({ ...base, status: 'correction_pending' }),
      now,
    );
    expect(() => AuditFindingSchema.parse(finding)).toThrow();
  });

  it('düzeltme görevi verilince geçerlidir', () => {
    const finding = buildAuditFinding(
      projectId,
      parseFindingInput({
        ...base, status: 'correction_pending',
        correctiveTaskId: '00000000-0000-4000-8000-000000000009',
      }),
      now,
    );
    expect(() => AuditFindingSchema.parse(finding)).not.toThrow();
  });
});
