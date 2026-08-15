import { describe, expect, it } from 'vitest';
import { PromptInputService } from './prompt-input-service.js';

describe('PromptInputService', () => {
  it('future cutoff ve high-water değerlerini fail-closed reddeder', async () => {
    const service = new PromptInputService({ build: async () => ({}) } as never, {} as never);
    await expect(service.build({ messages: [{ role: 'user', content: 'x' }], cursorOrdinal: 0,
      cutoffAt: '2026-08-15T00:00:02.000Z', sealedAt: '2026-08-15T00:00:01.000Z' } as never)).rejects.toThrow('sealedAt');
    await expect(service.build({ messages: [{ role: 'user', content: 'x' }], cursorOrdinal: Number.MAX_SAFE_INTEGER + 1 } as never)).rejects.toThrow('high-water');
  });
  it('caller tarafından verilen causal listeyi kullanmadan boş DB prefixini işler', async () => {
    const builder = { build: async () => ({
      contextSnapshotId: '10000000-0000-4000-8000-000000000001', baseContextCutoffAt: '2026-08-15T00:00:00.000Z',
      promptRefs: [], ruleRefs: [], standardRefs: [], requirementRefs: [], sourceVersionManifest: [{
        sourceType: 'task' as const, sourceId: 'task', version: 1, hash: 'a'.repeat(64),
      }],
    }) };
    const queries: string[] = [];
    const ch = {
      query: async (input: { query: string }) => { queries.push(input.query); return { json: async () => [] }; },
      insert: async () => undefined,
    };
    const service = new PromptInputService(builder as never, ch as never);
    await expect(service.build({
      projectId: '10000000-0000-4000-8000-000000000002', taskId: '10000000-0000-4000-8000-000000000003',
      taskBriefId: '10000000-0000-4000-8000-000000000004', assignmentAttemptId: '10000000-0000-4000-8000-000000000005',
      invocationId: '10000000-0000-4000-8000-000000000006', promptInputSnapshotId: '10000000-0000-4000-8000-000000000007',
      taskSource: { sourceType: 'task', sourceId: 'task', version: 1, hash: 'a'.repeat(64) },
      planSource: { sourceType: 'plan', sourceId: 'plan', version: 1, hash: 'b'.repeat(64) }, prompts: [], rules: [],
      standardKnowledgeIds: [], requirementKnowledgeIds: [], cutoffAt: '2026-08-15T00:00:00.000Z', sealedAt: '2026-08-15T00:00:01.000Z',
      messages: [], cursorOrdinal: 0,
    })).rejects.toThrow('en az bir mesaj');
    expect(queries).toHaveLength(0);
  });

  it('cursor ordinal negatifini fail-closed bırakır', async () => {
    const builder = { build: async () => ({ sourceVersionManifest: [] }) };
    const service = new PromptInputService(builder as never, {} as never);
    await expect(service.build({ messages: [{ role: 'user', content: 'x' }], cursorOrdinal: -1 } as never))
      .rejects.toThrow();
  });
});
