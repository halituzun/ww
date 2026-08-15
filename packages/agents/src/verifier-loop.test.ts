import { describe, expect, it } from 'vitest';
import { MockProvider, ModelRouter } from '@ww/providers';
import { runVerifierLoop } from './verifier-loop.js';

const id = (n: number): string => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const brief = { projectId: id(1), taskId: id(2), taskBriefId: id(3) } as never;
const attempt = { assignmentAttemptId: id(4), verifierAgentId: id(5) } as never;
const snapshot = { invocationId: id(6), promptInputSnapshotId: id(7) } as never;
const valid = { decision: 'approve', reasons: [{ message: 'ok', evidenceRefs: ['diff'] }], evidenceRefs: ['diff'], ruleRefs: [{ ruleId: 'TASK-001', ruleVersion: 1 }] };
function router(provider: MockProvider): ModelRouter { return new ModelRouter(new Map([['mock', provider]]), { fallbacks: () => [], usageSink: async () => undefined, invocationEffect: { run: async ({ execute }) => execute() } }); }

describe('verifier loop', () => {
  it('yalnız diff/summary görür, worker reasoning görmez ve strict wrapper parse eder', async () => {
    const provider = new MockProvider({ script: [{ content: null, toolCalls: [{ id: id(8), name: 'submit_verdict', args: { verdict: valid } }] }] });
    const result = await runVerifierLoop({ brief, attempt, snapshot, modelRef: 'mock:mock-model', router: router(provider), prompt: [{ role: 'system', content: 'criteria' }, { role: 'user', content: 'diff summary' }], diff: 'diff', summary: 'summary' });
    expect(result.verdict.decision).toBe('approve');
    expect(provider.calls[0]!.messages.some((message) => message.content.includes('private worker reasoning'))).toBe(false);
  });

  it('direct verdict ve forged extra alanlarını reddeder', async () => {
    const direct = new MockProvider({ script: [{ content: null, toolCalls: [{ id: id(8), name: 'submit_verdict', args: valid }] }] });
    await expect(runVerifierLoop({ brief, attempt, snapshot, modelRef: 'mock:mock-model', router: router(direct), prompt: [{ role: 'user', content: 'criteria' }], diff: 'diff', summary: 'summary' })).rejects.toThrow();
    const forged = new MockProvider({ script: [{ content: null, toolCalls: [{ id: id(8), name: 'submit_verdict', args: { verdict: valid, forgedExtra: true } }] }] });
    await expect(runVerifierLoop({ brief, attempt, snapshot, modelRef: 'mock:mock-model', router: router(forged), prompt: [{ role: 'user', content: 'criteria' }], diff: 'diff', summary: 'summary' })).rejects.toThrow();
  });
});
