import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { CouncilService } from './council-service.js';

describe('CouncilService', () => {
  it('runs a bounded proposal, objection and synthesis protocol', async () => {
    const sent: string[] = [];
    const service = new CouncilService({ send: async (input) => { sent.push(input.kind); return { messageId: randomUUID() }; } });
    const members = [1, 2, 3].map((n) => ({ agentId: randomUUID(), modelRef: `m${n}` }));
    const result = await service.run({ sessionId: randomUUID(), members, prompt: 'plan', maxCycles: 1 }, async ({ kind }) => ({ text: `${kind} response` }));
    expect(result.proposals).toHaveLength(3);
    expect(result.objections).toHaveLength(3);
    expect(result.synthesis.kind).toBe('synthesis');
    expect(sent).toHaveLength(7);
  });
});
