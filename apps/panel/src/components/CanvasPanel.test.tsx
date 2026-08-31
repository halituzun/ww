// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { CanvasPanel } from './CanvasPanel.js';

afterEach(cleanup);

// React Flow jsdom'da ResizeObserver ister.
globalThis.ResizeObserver ??= class {
  observe() { /* jsdom stub */ }
  unobserve() { /* jsdom stub */ }
  disconnect() { /* jsdom stub */ }
} as never;

const base = {
  projectId: 'p1',
  events: [],
  cursor: 0,
  onCursor: () => undefined,
  at: undefined,
  tasks: [{ task_id: 't1', title: 'Görev', status: 'done', priority: 0, updated_at: '' }],
  statusByTask: undefined,
  selectedAgent: undefined,
  onSelectAgent: vi.fn(),
} as const;

describe('CanvasPanel', () => {
  it('tuvali ve gorev grafigini birlikte cizer', () => {
    const { container } = render(<CanvasPanel {...base} />);
    expect(container.textContent).toBeTruthy();
  });

  // Geçmişe kaydırıldığında O ANKİ durumlar verilir; canlıdayken undefined.
  // İkisini karıştırmak, geçmişi canlı gibi göstermek olurdu.
  it('gecmis durumlari verildiginde de cizilir', () => {
    const { container } = render(
      <CanvasPanel {...base} statusByTask={new Map([['t1', 'working']])} />,
    );
    expect(container.textContent).toBeTruthy();
  });
});
