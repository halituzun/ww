// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TimelineScrubber } from './TimelineScrubber.js';

afterEach(cleanup);

const events = [1, 2, 3].map((seq) => ({
  event: 'status_change', cursor: String(seq), ts: '2026-08-18T00:00:00.000Z', data: {},
}));

describe('TimelineScrubber', () => {
  it('olay yokken kaydirici cizmez', () => {
    render(<TimelineScrubber events={[]} cursor={0} onCursor={vi.fn()} at={undefined} />);
    expect(screen.getByText(/henüz olay yok/i)).toBeDefined();
  });

  it('kaydirici hareketini bildirir', () => {
    const onCursor = vi.fn();
    render(<TimelineScrubber events={events} cursor={3} onCursor={onCursor} at={undefined} />);

    fireEvent.change(screen.getByLabelText('Geçmişte konum'), { target: { value: '1' } });
    expect(onCursor).toHaveBeenCalledWith(1);
  });

  // Canlı mı geçmişe mi bakıldığı yalnız renkle değil METİNLE söylenmelidir;
  // aksi halde kullanıcı eski durumu güncel sanır.
  it('gecmiste oldugunu metinle soyler', () => {
    render(<TimelineScrubber events={events} cursor={1} onCursor={vi.fn()} at={events[0]} />);
    expect(screen.getByText('GEÇMİŞ')).toBeDefined();
    expect(screen.getByText('1 / 3 olay')).toBeDefined();
  });

  it('sonda canli oldugunu soyler ve donus dugmesi gostermez', () => {
    render(<TimelineScrubber events={events} cursor={3} onCursor={vi.fn()} at={events[2]} />);
    expect(screen.getByText('CANLI')).toBeDefined();
    expect(screen.queryByText(/canlıya dön/i)).toBeNull();
  });

  it('canliya donus dugmesi sona tasir', () => {
    const onCursor = vi.fn();
    render(<TimelineScrubber events={events} cursor={1} onCursor={onCursor} at={events[0]} />);

    fireEvent.click(screen.getByText(/canlıya dön/i));
    expect(onCursor).toHaveBeenCalledWith(3);
  });
});

describe('TimelineScrubber — pencere sınırı', () => {
  const many = Array.from({ length: 100 }, (_, index) => ({
    event: 'status_change', cursor: String(index + 1), ts: '2026-08-18T00:00:00.000Z', data: {},
  }));

  // Kullanıcı "1 / 100"da geçmişin BAŞINDA olduğunu sanmamalı: daha eskisi
  // panel belleğinde yok.
  it('pencere doluyken bunu bildirir', () => {
    render(<TimelineScrubber events={many} cursor={100} onCursor={vi.fn()} at={many[99]} />);
    expect(screen.getByText(/pencere: son 100/)).toBeDefined();
  });

  it('pencere dolmamisken uyarmaz', () => {
    render(<TimelineScrubber events={events} cursor={3} onCursor={vi.fn()} at={events[2]} />);
    expect(screen.queryByText(/pencere: son/)).toBeNull();
  });
});
