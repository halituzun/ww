// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { TaskListPanel } from './TaskListPanel.js';

afterEach(cleanup);

const tasks = [
  { task_id: 't1', title: 'Renk yardımcısı', status: 'done', priority: 0, updated_at: '' },
  { task_id: 't2', title: 'Tahta bileşeni', status: 'queued', priority: 0, updated_at: '' },
];

describe('TaskListPanel', () => {
  it('gorev sayaclarini gosterir', () => {
    const { container } = render(
      <TaskListPanel tasks={tasks} statusCounts={{ done: 1, queued: 1 }} />,
    );
    // Durum adı hem sayaçta hem rozette geçer; sayaç KUTUSUNA bakılır.
    // Etiketler TÜRKÇE (karar K6): ham İngilizce kimlik kullanıcıya sızmaz.
    const metrics = container.querySelector('.metrics');
    expect(metrics?.textContent).toContain('bitti');
    expect(metrics?.textContent).toContain('kuyrukta');
  });

  it('her gorevi basligi ve durumuyla listeler', () => {
    render(<TaskListPanel tasks={tasks} statusCounts={{}} />);
    expect(screen.getByText('Renk yardımcısı')).toBeTruthy();
    expect(screen.getByText('Tahta bileşeni')).toBeTruthy();
    // Durum rozetleri de Türkçe.
    expect(screen.getByText('bitti')).toBeTruthy();
  });

  // BOŞ DURUM: docs/09 ui_audit "boş durum tasarlanmış mı" diye soruyor.
  // Boş bir liste, kullanıcıya "yükleniyor mu, yok mu?" sorusunu bıraktı.
  it('gorev yokken bos durumu acikca soyler', () => {
    render(<TaskListPanel tasks={[]} statusCounts={{}} />);
    expect(screen.getByText(/henüz görev yok/i)).toBeTruthy();
  });
});
