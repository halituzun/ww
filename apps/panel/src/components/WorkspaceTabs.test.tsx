// @vitest-environment jsdom
//
// NEDEN VAR: App.tsx'in sekme dağıtımı TEK SATIRDA 1083 karakterdi — iç içe
// beş ternary. Satır sayısı düşmüştü ama monolit yok olmamış, sıkışmıştı.
// Okunamaz bir satır uzun bir dosyadan iyi değildir (docs/09).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { WorkspaceTabs, type WorkspaceTabsProps } from './WorkspaceTabs.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const props = (over: Partial<WorkspaceTabsProps> = {}): WorkspaceTabsProps => ({
  tab: 'tasks',
  projectId: 'p1',
  tasks: [],
  statusCounts: {},
  events: [],
  timelineCursor: 0,
  onTimelineCursor: vi.fn(),
  replay: { visible: [], at: undefined, statusByTask: new Map<string, string>() },
  files: [],
  selectedFile: undefined,
  onSelectFile: vi.fn(),
  selectedAgent: undefined,
  onSelectAgent: vi.fn(),
  narratorQuestion: '',
  onNarratorQuestion: vi.fn(),
  onAskNarrator: vi.fn(),
  narratorResult: undefined,
  apiArtifacts: [],
  onActiveUrl: vi.fn(),
  onActiveSession: vi.fn(),
  ...over,
});

describe('WorkspaceTabs', () => {
  it('gorev sekmesinde gorev panelini cizer', () => {
    render(<WorkspaceTabs {...props({ tab: 'tasks' })} />);
    expect(screen.getByText(/henüz görev yok/i)).toBeDefined();
  });

  it('api sekmesinde konsolu cizer, gorev panelini cizmez', () => {
    render(<WorkspaceTabs {...props({ tab: 'api' })} />);
    expect(screen.getByText('API test konsolu')).toBeDefined();
    expect(screen.queryByText(/henüz görev yok/i)).toBeNull();
  });

  // Bilinmeyen sekme SESSİZCE boş kalmaz: dağıtıcının kapsamadığı bir değer
  // kullanıcıya boş bir kutu gösterirse hata teşhis edilemez.
  it('bilinmeyen sekmede onizlemeye duser', () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ targets: [] }),
    } as never);
    render(<WorkspaceTabs {...props({ tab: 'preview' as never })} />);
    expect(screen.queryByText(/henüz görev yok/i)).toBeNull();
  });
});
