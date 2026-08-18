// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PANEL_TABS, TabBar } from './TabBar.js';

afterEach(cleanup);

describe('TabBar', () => {
  it('docs/08de tanimli tum sekmeleri cizer', () => {
    render(<TabBar tab="tasks" onTab={() => undefined} counts={{}} />);
    for (const entry of PANEL_TABS) {
      expect(screen.getByRole('tab', { name: new RegExp(entry.label) })).toBeTruthy();
    }
  });

  it('secili sekmeyi isaretler', () => {
    render(<TabBar tab="files" onTab={() => undefined} counts={{}} />);
    expect(screen.getByRole('tab', { name: /Dosyalar/ }).getAttribute('aria-selected'))
      .toBe('true');
    expect(screen.getByRole('tab', { name: /Tuval/ }).getAttribute('aria-selected'))
      .toBe('false');
  });

  it('tiklaninca sekmeyi bildirir', () => {
    const onTab = vi.fn();
    render(<TabBar tab="tasks" onTab={onTab} counts={{}} />);
    fireEvent.click(screen.getByRole('tab', { name: /Tuval/ }));
    expect(onTab).toHaveBeenCalledWith('canvas');
  });

  it('sayaci olan sekmede sayiyi gosterir', () => {
    render(<TabBar tab="tasks" onTab={() => undefined} counts={{ tasks: 7 }} />);
    expect(screen.getByRole('tab', { name: /Görevler/ }).textContent).toContain('7');
  });

  // Sayaç YOKKEN sıfır yazmak yanıltıcıdır: "hiç yok" ile "daha yüklenmedi"
  // aynı şey değildir.
  it('sayac verilmediginde sifir yazmaz', () => {
    render(<TabBar tab="tasks" onTab={() => undefined} counts={{}} />);
    expect(screen.getByRole('tab', { name: /Görevler/ }).textContent).not.toContain('0');
  });
});
