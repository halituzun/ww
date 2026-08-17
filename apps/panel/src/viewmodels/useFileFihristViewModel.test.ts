// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { FileIndex } from '../services/projects.js';
import {
  narratorQuestionForFile,
  useFileFihristViewModel,
} from './useFileFihristViewModel.js';

afterEach(cleanup);

const file = (over: Partial<FileIndex> = {}): FileIndex => ({
  file_path: 'src/types.ts',
  summary: 'worker raporu',
  layer: 'other',
  exports: [],
  related_task_ids: ['8248aa61-b756-47b3-8c19-5858dc1ecadd'],
  last_commit_hash: '7fca8819',
  change_count: 1,
  updated_at: '2026-08-18T00:00:00.000Z',
  ...over,
});

describe('narratorQuestionForFile', () => {
  it('soruyu dosya yoluna baglar', () => {
    expect(narratorQuestionForFile('src/a.ts')).toContain('src/a.ts');
  });
});

describe('useFileFihristViewModel', () => {
  // ASIL KUSUR: REST bağları veriyordu, ClickHouse doğru dolduruyordu, ama
  // panel onları hiç göstermiyordu; kullanıcı dosyadan onu üreten işe
  // gidemiyordu (docs/11 Faz 5 kriteri).
  it('dosyanin ilgili gorevlerini acar', () => {
    const { result } = renderHook(() => useFileFihristViewModel('p1', file()));
    expect(result.current.relatedTaskIds).toEqual(['8248aa61-b756-47b3-8c19-5858dc1ecadd']);
  });

  it('dosya secili degilken bos liste doner', () => {
    const { result } = renderHook(() => useFileFihristViewModel('p1', undefined));
    expect(result.current.relatedTaskIds).toEqual([]);
  });

  it('anlatiyi narratordan dosyaya bagli soruyla ister', async () => {
    const ask = vi.fn(
      async (...args: [string, string]): Promise<{ answer: string; evidenceRefs: string[] }> => {
        void args;
        return { answer: 'Bu dosya X görevinde yazıldı.', evidenceRefs: [] };
      },
    );
    const { result } = renderHook(() => useFileFihristViewModel('p1', file(), { ask }));

    await act(async () => { await result.current.explain(); });

    expect(ask.mock.calls[0]![1]).toContain('src/types.ts');
    expect(result.current.narrative).toBe('Bu dosya X görevinde yazıldı.');
  });

  // Boş cevabı "anlatı geldi" gibi göstermek, kanıtı olmayan bir açıklama
  // varmış izlenimi verir.
  it('bos cevabi anlati gibi gostermez', async () => {
    const ask = vi.fn(async () => ({ answer: '   ', evidenceRefs: [] }));
    const { result } = renderHook(() => useFileFihristViewModel('p1', file(), { ask }));

    await act(async () => { await result.current.explain(); });

    expect(result.current.narrative).toBe('');
    expect(result.current.error).toMatch(/kanıt bulamadı/);
  });

  it('narrator hatasini yutmaz', async () => {
    const ask = vi.fn(async () => { throw new Error('sunucu düştü'); });
    const { result } = renderHook(() => useFileFihristViewModel('p1', file(), { ask } as never));

    await act(async () => { await result.current.explain(); });

    expect(result.current.error).toMatch(/sunucu düştü/);
    expect(result.current.loading).toBe(false);
  });

  it('dosya secili degilken narratora sormaz', async () => {
    const ask = vi.fn(async () => ({ answer: 'x', evidenceRefs: [] }));
    const { result } = renderHook(() => useFileFihristViewModel('p1', undefined, { ask }));

    await act(async () => { await result.current.explain(); });
    expect(ask).not.toHaveBeenCalled();
  });
});
