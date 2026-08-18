// @vitest-environment jsdom
//
// NEDEN VAR: üst şerit App.tsx içinde TEK SATIRDA 718 karakterdi ve iki ayrı
// sayfada (çalışma alanı / sağlayıcılar) elle kopyalanmıştı — biri
// değiştiğinde diğeri sessizce geride kalırdı.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TopBar } from './TopBar.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('TopBar', () => {
  it('canli baglanti durumunu TURKCE yazar', () => {
    render(<TopBar title="Agent çalışma alanı" connection="open" />);
    expect(screen.getByText('Canlı')).toBeDefined();
  });

  it('geri baglantisi verilince onu cizer, proje kutusunu cizmez', () => {
    const onBack = vi.fn();
    render(<TopBar title="API sağlayıcıları" onBack={onBack} />);
    fireEvent.click(screen.getByText(/Çalışma alanı/));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText('Proje kimliği')).toBeNull();
  });

  it('proje kimligi degisimini yukari bildirir', () => {
    const onProjectId = vi.fn();
    render(
      <TopBar
        title="Agent çalışma alanı"
        connection="offline"
        projectId=""
        onProjectId={onProjectId}
      />,
    );
    fireEvent.change(screen.getByLabelText('Proje kimliği'), { target: { value: 'p1' } });
    expect(onProjectId).toHaveBeenCalledWith('p1');
  });
});
