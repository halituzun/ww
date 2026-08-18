// @vitest-environment jsdom
//
// NEDEN VAR: docs/11 Faz 5 "bir dosyanın fihristinden ilgili göreve ve
// narrator anlatısına gidilir" diyor. Bağlar veride vardı ama panelde hiç
// çizilmiyordu; tip doğru olsa bile çizilmeyen bir panel kullanıcı için yoktur.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { FileIndex } from '../services/projects.js';
import { FileFihrist } from './FileFihrist.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const file: FileIndex = {
  file_path: 'src/types.ts',
  summary: 'worker raporu',
  layer: 'model',
  exports: [],
  related_task_ids: ['8248aa61-b756-47b3-8c19-5858dc1ecadd'],
  last_commit_hash: '7fca88191234',
  change_count: 2,
  updated_at: '2026-08-18T00:00:00.000Z',
};

describe('FileFihrist', () => {
  it('dosya secilmediginde yonlendirici ipucu gosterir', () => {
    render(<FileFihrist projectId="p1" file={undefined} />);
    expect(screen.getByText(/bir dosya seçin/i)).toBeDefined();
  });

  it('katman commit ve degisiklik sayisini gosterir', () => {
    render(<FileFihrist projectId="p1" file={file} />);
    expect(screen.getByText('model')).toBeDefined();
    expect(screen.getByText('7fca8819')).toBeDefined();
    expect(screen.getByText('2')).toBeDefined();
  });

  // Faz 5 kriteri: fihristten ilgili GÖREVE gidilir.
  it('ilgili gorevi tiklanabilir olarak listeler ve secimi bildirir', () => {
    const onSelectTask = vi.fn();
    render(<FileFihrist projectId="p1" file={file} onSelectTask={onSelectTask} />);

    fireEvent.click(screen.getByText('8248aa61'));
    expect(onSelectTask).toHaveBeenCalledWith('8248aa61-b756-47b3-8c19-5858dc1ecadd');
  });

  it('gorev bagi yoksa bunu acikca soyler', () => {
    render(<FileFihrist projectId="p1" file={{ ...file, related_task_ids: [] }} />);
    expect(screen.getByText(/bağlı görev kaydı yok/i)).toBeDefined();
  });

  // Faz 5 kriteri: narrator ANLATISINA gidilir.
  it('anlati butonu narrator cevabini gosterir', async () => {
    // http katmanı gövdeyi text() ile okur; json() yeterli değil.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({
        answer: 'Bu dosya 8248aa61 görevinde yazıldı.', evidenceRefs: [],
      }),
    } as never);

    render(<FileFihrist projectId="p1" file={file} />);
    fireEvent.click(screen.getByText(/nasıl yapıldı/i));

    await waitFor(() => expect(screen.getByText(/8248aa61 görevinde yazıldı/)).toBeDefined());
  });
});

describe('FileFihrist — çıktı bağları', () => {
  const withArtifacts: FileIndex = { ...file, related_artifact_ids: ['abbf4878-9f0c-4475-96cb-f2d2d142e56c'] };

  // docs/08: fihrist "ilişkili işler/kararlar" gösterir. Bağlar veride vardı
  // ama panelde tıklanamayan hiçbir şey yoktu.
  it('cikti kayitlarini tiklanabilir listeler', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({
        artifactId: 'abbf4878-9f0c-4475-96cb-f2d2d142e56c', taskId: 't1', type: 'model',
        name: 'useTodos.ts', path: 'src/viewmodels/useTodos.ts', summary: 'worker raporu',
        commitHash: '0363932612', createdAt: '2026-08-18T00:00:00.000Z',
      }),
    } as never);

    render(<FileFihrist projectId="p1" file={withArtifacts} />);
    fireEvent.click(screen.getByText('abbf4878'));

    await waitFor(() => expect(screen.getByText(/useTodos\.ts · model/)).toBeDefined());
    expect(screen.getByText('03639326')).toBeDefined();
  });

  it('cikti bagi yoksa bunu acikca soyler', () => {
    render(<FileFihrist projectId="p1" file={file} />);
    expect(screen.getByText(/bağlı çıktı kaydı yok/i)).toBeDefined();
  });

  // Hata yutulursa kullanıcı boş panele bakıp kaydın olmadığını sanır.
  it('cikti kaydi alinamazsa hatayi gosterir', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false, status: 404,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ message: 'artifact bulunamadi' }),
    } as never);

    render(<FileFihrist projectId="p1" file={withArtifacts} />);
    fireEvent.click(screen.getByText('abbf4878'));

    await waitFor(() => expect(screen.getByText(/artifact bulunamadi|Çıktı kaydı alınamadı/)).toBeDefined());
  });
});
