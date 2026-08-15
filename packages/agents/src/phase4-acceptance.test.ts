import { describe, expect, it } from 'vitest';
import { runPhase4Acceptance } from './phase4-acceptance.js';

describe('Phase 4 acceptance slice', () => {
  it('interview -> council -> audit produces one approved deterministic result', async () => {
    const result = await runPhase4Acceptance('11111111-1111-4111-8111-111111111111');
    expect(result.interviewComplete).toBe(true);
    expect(result.approved).toBe(true);
    expect(result.findingCount).toBe(1);
  });
});
