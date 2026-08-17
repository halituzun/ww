import { describe, expect, it, vi } from 'vitest';
import { canonicalSha256V1 } from '@ww/shared';
import { createRuntimeContextService, type PromptLoaderPort } from './runtime-context-service.js';

const id = (n: number): string => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

const brief = {
  projectId: id(1), taskId: id(2), taskBriefId: id(3),
  goal: 'Satranç tahtası',
  acceptanceCriteria: ['8x8'],
  targetFiles: ['src/Board.tsx'],
  allowedTools: ['read_file', 'write_file'],
  tokenBudget: 1000,
  promptRefs: [{ sourceType: 'prompt', sourceId: 'role.worker.coding', version: 1, hash: 'h' }],
  sourceVersionManifest: [{ sourceType: 'task', sourceId: id(2), version: 1, hash: 'h' }],
} as never;

const attempt = {
  assignmentAttemptId: id(4), projectId: id(1), taskId: id(2), taskBriefId: id(3),
  attemptNumber: 1, workerAgentId: id(5), verifierAgentId: id(6),
} as never;

const loader: PromptLoaderPort = {
  load: vi.fn(async () => 'Görev: {{task_description}} Kriter: {{acceptance_criteria}} Bağlam: {{context_pack}}'),
};

const service = (over: Partial<Parameters<typeof createRuntimeContextService>[0]> = {}) =>
  createRuntimeContextService({
    prompts: loader,
    workspaceRoot: '/w/satranc',
    models: { workerModelRef: 'deepseek:chat', verifierModelRef: 'openai:mini' },
    loadContextPack: async () => 'geçmiş yok',
    ...over,
  });

describe('createRuntimeContextService', () => {
  it('mühürlü snapshot, workspace ve model referanslarını döner', async () => {
    const result = await service().load({ brief, attempt });
    expect(result.workspaceRoot).toBe('/w/satranc');
    expect(result.workerModelRef).toBe('deepseek:chat');
    expect(result.verifierModelRef).toBe('openai:mini');
    expect(result.snapshot.promptMessages.length).toBeGreaterThan(0);
  });

  // Şema promptHash'in mesajlarla eşleşmesini ZORUNLU kılar; eşleşmezse
  // mühür geçersizdir ve çağrı reddedilir.
  it('promptHash mesajlarla birebir eşleşir', async () => {
    const result = await service().load({ brief, attempt });
    expect(result.snapshot.promptHash).toBe(canonicalSha256V1(result.snapshot.promptMessages));
  });

  // Cursor'un attempt'i snapshot'ınkiyle aynı olmalı (şema superRefine).
  it('causal cursor aynı attempt içinde kalır', async () => {
    const result = await service().load({ brief, attempt });
    expect(result.snapshot.inputTaskCausalCursor.assignmentAttemptId)
      .toBe(result.snapshot.assignmentAttemptId);
  });

  it('brief kimliklerini snapshot’a taşır', async () => {
    const result = await service().load({ brief, attempt });
    expect(result.snapshot).toMatchObject({
      projectId: id(1), taskId: id(2), taskBriefId: id(3), assignmentAttemptId: id(4),
    });
  });

  it('kaynak sürüm manifestosunu brief’ten alır', async () => {
    const result = await service().load({ brief, attempt });
    expect(result.snapshot.sourceVersionManifest).toEqual(brief.sourceVersionManifest);
  });

  // Her çağrı ayrı bir model çağrısıdır; aynı invocationId iki çağrıyı
  // tek olay gibi gösterir ve kontör/iz sürme bozulur.
  it('her yüklemede benzersiz invocationId üretir', async () => {
    const svc = service();
    const a = await svc.load({ brief, attempt });
    const b = await svc.load({ brief, attempt });
    expect(a.snapshot.invocationId).not.toBe(b.snapshot.invocationId);
  });

  it('prompt bulunamazsa açık hata verir', async () => {
    const svc = service({ prompts: { load: async () => null } });
    await expect(svc.load({ brief, attempt })).rejects.toThrow(/prompt/i);
  });

  it('bağlam paketi prompta girer', async () => {
    const svc = service({ loadContextPack: async () => 'ÖNCEKİ KARAR: react' });
    const result = await svc.load({ brief, attempt });
    const text = result.snapshot.promptMessages.map((m) => m.content).join('\n');
    expect(text).toContain('ÖNCEKİ KARAR: react');
  });
});
