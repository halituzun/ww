// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ProjectPicker } from './ProjectPicker.js';
import type { Project } from '../services/projects.js';

afterEach(cleanup);

const projects: readonly Project[] = [
  { project_id: 'p1', name: 'Satranç', type: 'web', status: 'running' },
  { project_id: 'p2', name: 'Todo', type: 'api', status: 'draft' },
];

const base = {
  projects,
  draft: { name: '', type: 'web', budget: '5' },
  onDraft: () => undefined,
  onCreate: () => undefined,
  statusMessage: '',
  onSelect: () => undefined,
} as const;

describe('ProjectPicker', () => {
  it('projeleri adi ve turuyle listeler', () => {
    render(<ProjectPicker {...base} />);
    expect(screen.getByText('Satranç')).toBeTruthy();
    expect(screen.getByText(/web · p1/)).toBeTruthy();
  });

  it('projeye tiklaninca secimi bildirir', () => {
    const onSelect = vi.fn();
    render(<ProjectPicker {...base} onSelect={onSelect} />);
    fireEvent.click(screen.getByText('Todo'));
    expect(onSelect).toHaveBeenCalledWith('p2');
  });

  it('proje olustur dugmesi cagriyi iletir', () => {
    const onCreate = vi.fn();
    render(<ProjectPicker {...base} onCreate={onCreate} />);
    fireEvent.click(screen.getByRole('button', { name: /Proje oluştur/ }));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('ad yazilinca taslagi gunceller', () => {
    const onDraft = vi.fn();
    render(<ProjectPicker {...base} onDraft={onDraft} />);
    fireEvent.change(screen.getByLabelText('Proje adı'), { target: { value: 'Yeni' } });
    expect(onDraft).toHaveBeenCalledWith({ name: 'Yeni' });
  });

  it('durum mesajini gosterir', () => {
    render(<ProjectPicker {...base} statusMessage="proje oluşturuldu" />);
    expect(screen.getByText('proje oluşturuldu')).toBeTruthy();
  });

  // docs/09 ui_audit: boş durum tasarlanmış olmalı.
  it('proje yokken bos durumu soyler', () => {
    render(<ProjectPicker {...base} projects={[]} />);
    expect(screen.getByText(/henüz proje yok/i)).toBeTruthy();
  });
});
