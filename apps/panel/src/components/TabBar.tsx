// Sekme çubuğu — SALT GÖRÜNÜM (docs/08 → genel yerleşim).
//
// NEDEN AYRI: App.tsx'te 1337 karakterlik tek satırdı ve altı sekme elle
// tekrarlanıyordu; yeni sekme eklemek satırı daha da uzatıyordu.
//
// Erişilebilirlik (docs/09 ui_audit): sekmeler `role="tab"` ve
// `aria-selected` taşır. Eskiden yalnız CSS sınıfı ("active") vardı, yani
// hangi sekmenin seçili olduğu ekran okuyucuya HİÇ söylenmiyordu — renk tek
// başına bilgi taşımaz.
import type { PanelTab } from '../services/tabs.js';

export type { PanelTab };

export const PANEL_TABS: readonly {
  readonly id: PanelTab;
  readonly label: string;
  /** Sayaç anahtarı; yoksa sekme sayı göstermez. */
  readonly countKey?: 'tasks' | 'events';
}[] = Object.freeze([
  { id: 'tasks', label: 'Görevler', countKey: 'tasks' },
  { id: 'canvas', label: 'Tuval' },
  { id: 'files', label: 'Dosyalar' },
  { id: 'timeline', label: 'Zaman çizelgesi', countKey: 'events' },
  { id: 'api', label: 'API' },
  { id: 'preview', label: 'Önizleme' },
]);

export function TabBar({ tab, onTab, counts }: {
  readonly tab: PanelTab;
  readonly onTab: (next: PanelTab) => void;
  readonly counts: Readonly<Partial<Record<'tasks' | 'events', number>>>;
}) {
  return (
    <nav className="tabs" role="tablist">
      {PANEL_TABS.map((entry) => {
        // Sayaç YOKKEN sıfır yazmak yanıltıcıdır: "hiç yok" ile "daha
        // yüklenmedi" aynı şey değildir.
        const count = entry.countKey === undefined ? undefined : counts[entry.countKey];
        return (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            className={tab === entry.id ? 'active' : ''}
            onClick={() => onTab(entry.id)}
          >
            {entry.label}
            {count === undefined ? null : <span>{count}</span>}
          </button>
        );
      })}
    </nav>
  );
}
