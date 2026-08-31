import { describe, expect, it } from 'vitest';
import { NarratorService } from './narrator-service.js';

describe('NarratorService', () => {
  it('answers only from evidence at or before cutoff', () => {
    const result = new NarratorService().answer({ projectId: '11111111-1111-4111-8111-111111111111', question: 'neden', cutoffAt: '2026-01-02T00:00:00.000Z', evidence: [{ source: 'event:1', summary: 'eski karar', createdAt: '2026-01-01T00:00:00.000Z' }, { source: 'event:2', summary: 'gelecek karar', createdAt: '2026-01-03T00:00:00.000Z' }] });
    expect(result.answer).toContain('eski karar');
    expect(result.answer).not.toContain('gelecek');
    expect(result.evidenceRefs).toEqual(['event:1']);
  });
});
