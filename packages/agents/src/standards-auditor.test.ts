import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { StandardsAuditor } from './standards-auditor.js';

describe('StandardsAuditor', () => {
  it('writes a deterministic-shape finding with evidence', async () => {
    const rows: unknown[] = [];
    const auditor = new StandardsAuditor({ create: async (finding) => { rows.push(finding); } });
    const finding = await auditor.record({ projectId: randomUUID(), ruleId: 'NO_SECRET_LEAK', summary: 'secret leak', evidenceRefs: ['event:1'], createdAt: new Date().toISOString() });
    expect(finding.status).toBe('open');
    expect(rows).toHaveLength(1);
  });
});
