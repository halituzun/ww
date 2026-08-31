import type { PaletteAction } from "../viewmodels/useCommandPaletteViewModel.js";

export function CommandPalette({
  isOpen,
  onClose,
  query,
  onQueryChange,
  actions,
  selectedIndex,
  onSelectIndex,
}: {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly query: string;
  readonly onQueryChange: (q: string) => void;
  readonly actions: readonly PaletteAction[];
  readonly selectedIndex: number;
  readonly onSelectIndex: (idx: number) => void;
}) {
  if (!isOpen) return null;

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      onSelectIndex(actions.length > 0 ? (selectedIndex + 1) % actions.length : 0);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      onSelectIndex(actions.length > 0 ? (selectedIndex - 1 + actions.length) % actions.length : 0);
    } else if (e.key === "Enter" && actions[selectedIndex]) {
      e.preventDefault();
      actions[selectedIndex].onSelect();
    }
  }

  return (
    <div className="palette-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="Komut Paleti">
      <div className="palette-modal" onClick={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
        <div className="palette-search-row">
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="#64748b" strokeWidth="1.8">
            <circle cx="7" cy="7" r="4.25" />
            <path d="M10.2 10.2L14 14" />
          </svg>
          <input
            type="text"
            className="palette-input"
            aria-label="Komut ara"
            placeholder="Bir komut veya sayfa arayın…"
            value={query}
            onChange={(e) => {
              onQueryChange(e.target.value);
              onSelectIndex(0);
            }}
            autoFocus
          />
          <kbd className="esc-badge">ESC</kbd>
        </div>

        <div className="palette-list" role="listbox">
          {actions.length === 0 ? (
            <p className="palette-empty-hint">Eşleşen eylem bulunamadı.</p>
          ) : (
            actions.map((act, idx) => {
              const isSelected = idx === selectedIndex;
              return (
                <div
                  key={act.id}
                  className={`palette-item ${isSelected ? "active" : ""}`}
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => act.onSelect()}
                  onMouseEnter={() => onSelectIndex(idx)}
                >
                  <span className="palette-item-cat">{act.category}</span>
                  <strong className="palette-item-title">{act.title}</strong>
                  {act.shortcut ? <kbd>{act.shortcut}</kbd> : null}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
