// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ProjectControls } from './ProjectControls.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('ProjectControls', () => {
  it('duraklatilmis projede DEVAM ET onerir', () => {
    const onStatus = vi.fn();
    render(<ProjectControls status="paused" onStatus={onStatus} />);
    fireEvent.click(screen.getByText('Devam et'));
    expect(onStatus).toHaveBeenCalledWith('running');
  });

  it('kosan projede DURAKLAT onerir', () => {
    const onStatus = vi.fn();
    render(<ProjectControls status="running" onStatus={onStatus} />);
    fireEvent.click(screen.getByText('Duraklat'));
    expect(onStatus).toHaveBeenCalledWith('paused');
  });

  // Durum HENÜZ GELMEDİYSE boş bir rozet göstermek "durumsuz proje" yalanıdır.
  it('durum bilinmiyorken yukleniyor yazar', () => {
    render(<ProjectControls status="" onStatus={vi.fn()} />);
    expect(screen.getByText('yükleniyor')).toBeDefined();
  });
});
