// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { TaskCanvas } from './TaskCanvas.js';

afterEach(cleanup);

// React Flow jsdom'da ResizeObserver ister.
globalThis.ResizeObserver ??= class {
  observe() { /* jsdom stub */ }
  unobserve() { /* jsdom stub */ }
  disconnect() { /* jsdom stub */ }
} as never;

const task = (over: Record<string, unknown> = {}) => ({
  task_id: 't1', title: 'Renk yardımcısı', status: 'done',
  depends_on: [], parent_task_id: undefined, ...over,
} as never);

describe('TaskCanvas', () => {
  // docs/09 ui_audit: boş durum tasarlanmış olmalı. Boş bir TUVAL, hata mı
  // yok mu belli olmayan bir beyaz alandır — kullanıcı "yükleniyor mu?" diye
  // bakakalır.
  it('gorev yokken bos durumu soyler', () => {
    render(<TaskCanvas tasks={[]} />);
    expect(screen.getByText(/henüz görev yok/i)).toBeTruthy();
  });

  it('gorev varken tuvali cizer', () => {
    const { container } = render(<TaskCanvas tasks={[task()]} />);
    expect(container.querySelector('.react-flow')).toBeTruthy();
  });

  // Geçmişe kaydırıldığında O ANKİ durum yazılır; olayı olmayan görev
  // "bilinmiyor" olur. Şimdiki durumu geçmişe yazmak olmayan bir geçmiş
  // uydurmak olurdu.
  it('gecmiste olayi olmayan gorevi bilinmiyor yazar', () => {
    const { container } = render(
      <TaskCanvas tasks={[task()]} statusByTask={new Map()} />,
    );
    expect(container.textContent).toContain('bilinmiyor');
  });

  it('gecmis durumu verildiginde onu yazar', () => {
    const { container } = render(
      <TaskCanvas tasks={[task()]} statusByTask={new Map([['t1', 'working']])} />,
    );
    expect(container.textContent).toContain('working');
  });
});
