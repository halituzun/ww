import { canonicalSha256V1, type AuditFinding, type EntityId } from '@ww/shared';
import { randomUUID } from 'node:crypto';

export interface StandardsAuditInput {
  readonly projectId: EntityId;
  readonly taskId?: EntityId;
  readonly profile?: 'verifier' | 'communication_audit';
  readonly ruleId: AuditFinding['rule']['ruleId'];
  readonly ruleVersion?: number;
  readonly summary: string;
  readonly evidenceRefs: readonly string[];
  readonly severity?: AuditFinding['severity'];
  readonly createdAt: string;
}

export interface StandardsFindingSink { create(finding: AuditFinding): Promise<void>; }

export class StandardsAuditor {
  readonly #sink: StandardsFindingSink;
  constructor(sink: StandardsFindingSink) { this.#sink = sink; }
  async record(input: StandardsAuditInput): Promise<AuditFinding> {
    const finding = Object.freeze({
      findingId: randomUUID() as EntityId,
      projectId: input.projectId,
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      profile: input.profile ?? 'verifier',
      rule: { ruleId: input.ruleId, ruleVersion: input.ruleVersion ?? 1 },
      severity: input.severity ?? 'medium',
      summary: input.summary.trim(),
      evidenceRefs: Object.freeze([...input.evidenceRefs]),
      status: 'open' as const,
      createdAt: input.createdAt,
    });
    if (finding.summary.length === 0 || finding.evidenceRefs.length === 0) throw new Error('audit bulgusu kanit tasimalidir');
    await this.#sink.create(finding);
    return Object.freeze({ ...finding, evidenceRefs: [...finding.evidenceRefs], findingHash: canonicalSha256V1(finding) } as AuditFinding & { readonly findingHash: string });
  }
}
