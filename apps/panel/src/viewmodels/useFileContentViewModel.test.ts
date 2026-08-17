// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { useFileContentViewModel } from './useFileContentViewModel.js';

afterEach(cleanup);

const file = (content: string) => ({ content, filePath: 'src/a.ts' });

describe('useFileContentViewModel', () => {
  it('dosya secilmediginde istek atmaz', () => {
    const fetchContent = vi.fn(async () => file('x'));
    const { result } = renderHook(() =>
      useFileContentViewModel('p1', undefined, { fetchContent } as never));

    expect(fetchContent).not.toHaveBeenCalled();
    expect(result.current.value).toContain('Bir dosya seçin');
  });

  it('gercek icerigi yukler', async () => {
    const fetchContent = vi.fn(async () => file('export const a = 1;'));
    const { result } = renderHook(() =>
      useFileContentViewModel('p1', 'src/a.ts', { fetchContent } as never));

    await waitFor(() => expect(result.current.value).toBe('export const a = 1;'));
    expect(fetchContent).toHaveBeenCalledWith('p1', 'src/a.ts');
  });

  // ASIL RİSK: okunamayan dosyaya yer tutucu metin koymak, kullanıcıya
  // dosyayı gördüğü yalanını söyler.
  it('okunamayan dosyayi acikca bildirir', async () => {
    const fetchContent = vi.fn(async () => null);
    const { result } = renderHook(() =>
      useFileContentViewModel('p1', 'src/yok.ts', { fetchContent } as never));

    await waitFor(() => expect(result.current.state).toBe('missing'));
    expect(result.current.value).toContain('okunamadı');
    expect(result.current.content).toBeNull();
  });

  // Boş içerikli dosya "okunamadı" DEĞİLDİR; ikisini karıştırmak
  // kullanıcıya olmayan bir hata gösterir.
  it('bos dosyayi okunamadi saymaz', async () => {
    const fetchContent = vi.fn(async () => file(''));
    const { result } = renderHook(() =>
      useFileContentViewModel('p1', 'src/bos.ts', { fetchContent } as never));

    await waitFor(() => expect(result.current.state).toBe('idle'));
    expect(result.current.value).toBe('');
  });

  // Dosya değişince önceki isteğin geç dönen cevabı yeni dosyanın üzerine
  // yazmamalıdır.
  it('dosya degisince eski istegi yok sayar', async () => {
    let resolveFirst: ((value: unknown) => void) | undefined;
    const fetchContent = vi.fn((_: string, path: string) =>
      path === 'src/ilk.ts'
        ? new Promise((resolve) => { resolveFirst = resolve; })
        : Promise.resolve(file('ikinci')));

    const { result, rerender } = renderHook(
      ({ path }: { path: string }) =>
        useFileContentViewModel('p1', path, { fetchContent } as never),
      { initialProps: { path: 'src/ilk.ts' } },
    );
    rerender({ path: 'src/iki.ts' });
    await waitFor(() => expect(result.current.value).toBe('ikinci'));

    resolveFirst?.(file('ilk'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current.value).toBe('ikinci');
  });
});
