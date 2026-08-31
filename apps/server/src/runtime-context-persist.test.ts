// Mühürlü prompt girdisinin KALICI yazılması.
//
// NEDEN VAR: anlık görüntü yalnızca bellekte kuruluyordu ve hiç yazılmıyordu.
// Canlı veritabanında `api_usage`'da 216 çağrı bir prompt anlık görüntüsüne
// atıf yapıyordu ama `prompt_input_snapshots` tablosu BOŞTU: her çağrı var
// olmayan bir kayda işaret ediyordu ve "bu çıktıyı hangi prompt üretti"
// sorusunun cevabı yoktu.
import { describe, expect, it, vi } from 'vitest';
import { createRuntimeContextService } from './runtime-context-service.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const brief = {
  taskId: id(1),
  goal: 'src/a.ts dosyasını oluştur',
  acceptanceCriteria: ['src/a.ts var'],
  targetFiles: ['src/a.ts'],
  allowedTools: ['write_file'],
  tokenBudget: 1000,
  promptRefs: [{ sourceId: 'role.worker', version: 1 }],
  sourceVersionManifest: { sources: [] },
} as never;

const attempt = {
  projectId: id(2), taskBriefId: id(3), assignmentAttemptId: id(4),
} as never;

const service = (persistSnapshot?: (snapshot: unknown) => Promise<unknown>) =>
  createRuntimeContextService({
    prompts: { load: async () => 'Sen bir worker agent’sın.' },
    workspaceRoot: '/tmp/ww',
    models: { workerModelRef: 'deepseek:deepseek-chat', verifierModelRef: 'deepseek:deepseek-chat' },
    loadContextPack: async () => 'bağlam',
    ...(persistSnapshot === undefined ? {} : { persistSnapshot: persistSnapshot as never }),
  });

describe('createRuntimeContextService — mühür kalıcılığı', () => {
  it('muhurlu girdiyi kalici yazar', async () => {
    const persist = vi.fn(async () => undefined);
    const result = await service(persist).load({ brief, attempt });

    expect(persist).toHaveBeenCalledTimes(1);
    const written = persist.mock.calls[0]![0] as { promptInputSnapshotId: string };
    expect(written.promptInputSnapshotId).toBe(result.snapshot.promptInputSnapshotId);
  });

  // Mühür SÖZLEŞMEDİR: yazılamazsa çağrı da yapılmamalıdır, yoksa provenance
  // iddiası yalan olur.
  it('yazma dustugunde cagri yapilmaz', async () => {
    await expect(
      service(async () => { throw new Error('clickhouse yazılamadı'); }).load({ brief, attempt }),
    ).rejects.toThrow(/clickhouse/);
  });

  it('yazilan muhur mesajlarla eslesir', async () => {
    const persist = vi.fn(async () => undefined);
    await service(persist).load({ brief, attempt });
    const written = persist.mock.calls[0]![0] as {
      promptMessages: readonly { content: string }[]; promptHash: string;
    };

    expect(written.promptMessages.length).toBeGreaterThan(0);
    expect(written.promptHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('createRuntimeContextService — nedensel imleç', () => {
  // ASIL KUSUR: imleç SABİT 0 yazılıyordu; her mühür "bu agent daha önce
  // hiçbir şey görmedi" diyordu ve replay yanlış noktadan başlardı.
  it('gercek imleci muhre yazar', async () => {
    const loadCausalOrdinal = vi.fn(async () => 7);
    const result = await createRuntimeContextService({
      prompts: { load: async () => 'şablon' },
      workspaceRoot: '/tmp/ww',
      models: { workerModelRef: 'm:1', verifierModelRef: 'm:1' },
      loadContextPack: async () => '',
      loadCausalOrdinal,
    }).load({ brief, attempt });

    expect(loadCausalOrdinal).toHaveBeenCalledWith({
      taskId: id(1), assignmentAttemptId: id(4),
    });
    expect((result.snapshot as unknown as {
      inputTaskCausalCursor: { ordinal: number };
    }).inputTaskCausalCursor.ordinal).toBe(7);
  });

  // Kayıt yoksa 0 DOĞRUDUR (henüz hiçbir girdi işlenmemiştir), uydurma değil.
  it('imlec okuyucusu verilmezse sifir kalir', async () => {
    const result = await createRuntimeContextService({
      prompts: { load: async () => 'şablon' },
      workspaceRoot: '/tmp/ww',
      models: { workerModelRef: 'm:1', verifierModelRef: 'm:1' },
      loadContextPack: async () => '',
    }).load({ brief, attempt });

    expect((result.snapshot as unknown as {
      inputTaskCausalCursor: { ordinal: number };
    }).inputTaskCausalCursor.ordinal).toBe(0);
  });
});
