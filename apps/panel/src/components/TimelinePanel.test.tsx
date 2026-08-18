// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { TimelinePanel } from './TimelinePanel.js';

afterEach(cleanup);

const cursorOf = (n: number) => `2026-08-18 09:00:0${n}.000|id${n}`;
const item = (n: number, event: string) => ({
  cursor: cursorOf(n), event, ts: `2026-08-18T09:00:0${n}.000Z`, data: {},
});

const base = {
  events: [item(1, 'commit'), item(2, 'status_change')],
  cursor: 2,
  onCursor: () => undefined,
  visible: [item(1, 'commit'), item(2, 'status_change')],
  at: item(2, 'status_change'),
};

describe('TimelinePanel', () => {
  it('olaylari EN YENIDEN eskiye siralar', () => {
    const { container } = render(<TimelinePanel {...base} />);
    const rows = [...container.querySelectorAll('.timeline li')];
    // Ters sıra kasıtlı: kullanıcı en son olanı en üstte görmek ister.
    expect(rows[0]?.textContent).toContain('status_change');
    expect(rows[1]?.textContent).toContain('commit');
  });

  it('imleci kod olarak gosterir', () => {
    const { container } = render(<TimelinePanel {...base} />);
    expect(container.querySelector('.timeline code')?.textContent)
      .toContain(cursorOf(2));
  });

  // docs/09 ui_audit boş durumu ister, İKİ KEZ istemez: kaydırıcı zaten
  // söylüyor, liste onu tekrarlamaz.
  it('olay yokken bos durum TEK KEZ soylenir', () => {
    render(<TimelinePanel {...base} events={[]} visible={[]} at={undefined} />);
    expect(screen.getAllByText(/henüz olay yok/i)).toHaveLength(1);
  });

  it('olay yokken liste hic cizilmez', () => {
    const { container } = render(
      <TimelinePanel {...base} events={[]} visible={[]} at={undefined} />,
    );
    expect(container.querySelector('.timeline')).toBeNull();
  });
});
