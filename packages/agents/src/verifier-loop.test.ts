import { POLICY_RULE_IDS } from '@ww/shared';
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

// ASIL KUSUR: model bazen aracı hiç çağırmadan düz metin döndürüyor ve
// doğrulama adımı hiç tamamlanamıyordu (sağlayıcıda tool_choice zorlaması yok).
describe('runVerifierLoop araç çağırmayan model', () => {
  const rule = { ruleId: POLICY_RULE_IDS[0], ruleVersion: 1 };
  const verdictArgs = {
    verdict: {
      decision: 'approve',
      reasons: [{ message: 'kabul', evidenceRefs: ['file:a.ts'] }],
      evidenceRefs: ['file:a.ts'],
      ruleRefs: [rule],
    },
  };

  const router = (first: unknown[], second: unknown[]) => {
    let call = 0;
    return {
      complete: async () => {
        call += 1;
        return { result: { toolCalls: call === 1 ? first : second, content: null } };
      },
      calls: () => call,
    };
  };

  const run = (r: ReturnType<typeof router>) => runVerifierLoop({
    brief: { projectId: id(1), taskId: id(2), taskBriefId: id(3) } as never,
    attempt: { assignmentAttemptId: id(4), verifierAgentId: id(6) } as never,
    snapshot: { invocationId: id(7), promptInputSnapshotId: id(8) } as never,
    modelRef: 'm', prompt: [], router: r as never,
  } as never);

  it('araç çağrılmazsa bir kez daha ısrarla dener', async () => {
    const r = router([], [{ name: 'submit_verdict', args: verdictArgs }]);
    const result = await run(r);
    expect(result.verdict.decision).toBe('approve');
    expect(r.calls()).toBe(2);
  });

  // Verdikt UYDURULMAZ: ikinci denemede de çağırmazsa hata açık kalır.
  it('ikinci denemede de çağırmazsa hata verir', async () => {
    await expect(run(router([], []))).rejects.toThrow(/submit_verdict/);
  });
});
