// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FileBrowserPanel } from './FileBrowserPanel.js';
import type { FileIndex } from '../services/projects.js';

afterEach(cleanup);

// Fikstür TİPİN TAMAMINI taşır. Eksik alanları `as never` ile gizlemek,
// gerçeğe benzemeyen bir sahte üretir ve testi yanıltıcı yapar.
const file = (over: Partial<FileIndex>): FileIndex => ({
  file_path: 'src/a.ts', summary: 'a özeti', layer: 'model',
  exports: [], related_task_ids: [], related_artifact_ids: [],
  last_commit_hash: '', change_count: 2, updated_at: '2026-08-18T00:00:00.000Z',
  ...over,
});

const files: readonly FileIndex[] = [
  file({}),
  file({ file_path: 'src/b.ts', layer: 'view', change_count: 1, summary: 'b özeti' }),
];

const base = {
  projectId: 'p1', files, selectedFile: 'src/a.ts' as string | undefined, onSelectFile: () => undefined,
  narratorQuestion: '', onNarratorQuestion: () => undefined,
  onAskNarrator: () => undefined, narratorResult: undefined,
} as const;

describe('FileBrowserPanel', () => {
  it('dosyalari yol ve degisiklik sayisiyla listeler', () => {
    const { container } = render(<FileBrowserPanel {...base} />);
    // Yol hem listede hem fihrist başlığında geçer; LİSTEYE bakılır.
    const list = container.querySelector('.file-list');
    expect(list?.textContent).toContain('src/a.ts');
    expect(list?.textContent).toContain('2 değişiklik');
  });

  it('secili dosyayi isaretler', () => {
    const { container } = render(<FileBrowserPanel {...base} />);
    expect(container.querySelector('li.active')?.textContent).toContain('src/a.ts');
  });

  it('dosyaya tiklaninca secimi bildirir', () => {
    const onSelectFile = vi.fn();
    render(<FileBrowserPanel {...base} onSelectFile={onSelectFile} />);
    fireEvent.click(screen.getByText('src/b.ts'));
    expect(onSelectFile).toHaveBeenCalledWith('src/b.ts');
  });

  // docs/09 ui_audit: boş durum tasarlanmış olmalı.
  it('dosya yokken bos durumu soyler', () => {
    render(<FileBrowserPanel {...base} files={[]} selectedFile={undefined} />);
    expect(screen.getByText(/henüz dosya yok/i)).toBeTruthy();
  });

  it('anlatici cevabini ve kanit sayisini gosterir', () => {
    render(<FileBrowserPanel {...base} narratorResult={{ answer: 'şöyle yapıldı', evidenceRefs: ['a', 'b'] }} />);
    expect(screen.getByText('şöyle yapıldı')).toBeTruthy();
    expect(screen.getByText(/2 kanıt kaynağı/)).toBeTruthy();
  });
});
