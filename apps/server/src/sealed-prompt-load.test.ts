// Mühürlü prompt SÜRÜMÜNÜN okunması.
//
// NEDEN VAR: yükleyicinin imzası `load(name, version)` idi ama uygulama
// `version`ı yok sayıp o an AKTİF prompt'u okuyordu. Brief v3'ü mühürlese
// bile prompt sonradan düzenlenmişse koşu v7 ile yapılıyor, yani mühür yalan
// oluyor ve "bu çıktıyı hangi prompt üretti" sorusunun cevabı yanlış çıkıyordu.
import { describe, expect, it, vi } from 'vitest';
import { createRuntimeContextService } from './runtime-context-service.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const brief = {
  taskId: id(1), goal: 'hedef', acceptanceCriteria: ['k'], targetFiles: ['src/a.ts'],
  allowedTools: ['write_file'], tokenBudget: 1000,
  promptRefs: [{ sourceId: 'role.worker', version: 3 }],
  sourceVersionManifest: { sources: [] },
} as never;

const attempt = { projectId: id(2), taskBriefId: id(3), assignmentAttemptId: id(4) } as never;

describe('mühürlü prompt yüklemesi', () => {
  it('yukleyiciye MUHURLENEN surumu gecirir', async () => {
    const load = vi.fn(async () => 'şablon');
    await createRuntimeContextService({
      prompts: { load },
      workspaceRoot: '/tmp/ww',
      models: { workerModelRef: 'm:1', verifierModelRef: 'm:1' },
      loadContextPack: async () => '',
    }).load({ brief, attempt });

    expect(load).toHaveBeenCalledWith('role.worker', 3);
  });

  // Mühürlenen sürüm bulunamazsa AKTİF olana düşmek sessiz bir sürüm
  // kaymasıdır; hiç koşmamak daha iyidir.
  it('muhurlenen surum bulunamazsa acik hata verir', async () => {
    await expect(createRuntimeContextService({
      prompts: { load: async () => null },
      workspaceRoot: '/tmp/ww',
      models: { workerModelRef: 'm:1', verifierModelRef: 'm:1' },
      loadContextPack: async () => '',
    }).load({ brief, attempt })).rejects.toThrow(/prompt bulunamadı: role\.worker v3/);
  });
});
