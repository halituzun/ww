// Zaman çizelgesi kaydırıcısı — SALT GÖRÜNÜM (docs/09 MVVM).
//
// docs/11 Faz 5: "geçmişe kaydırıcıyla dönülür". Panelde yalnızca canlı olay
// listesi vardı; geçmişe dönmek mümkün değildi.
import { TIMELINE_LIMIT } from '../viewmodels/workspace-logic.js';
import type { ReplayEvent } from '../viewmodels/timeline-replay.js';

export function TimelineScrubber({ events, cursor, onCursor, at }: {
  readonly events: readonly ReplayEvent[];
  readonly cursor: number;
  readonly onCursor: (cursor: number) => void;
  readonly at: ReplayEvent | undefined;
}) {
  const total = events.length;
  if (total === 0) return <p className="hint">Henüz olay yok.</p>;
  const live = cursor >= total;
  // Panel belleğinde yalnızca son TIMELINE_LIMIT olay tutulur. Bunu
  // söylemezsek kullanıcı "1 / 100"da geçmişin BAŞINDA olduğunu sanır;
  // oysa daha eskisi pencerede yoktur.
  const windowed = total >= TIMELINE_LIMIT;

  return (
    <div className="scrubber" aria-label="Zaman çizelgesi kaydırıcısı">
      <input
        type="range"
        min={0}
        max={total}
        value={Math.min(cursor, total)}
        aria-label="Geçmişte konum"
        onChange={(changeEvent) => onCursor(Number(changeEvent.target.value))}
      />
      <div className="scrubber__meta">
        {/* Canlı mı geçmiş mi olduğu METİNLE yazılır; yalnız renk yeterli değil. */}
        <strong>{live ? 'CANLI' : 'GEÇMİŞ'}</strong>
        <span>{Math.min(cursor, total)} / {total} olay</span>
        {windowed ? <span title="Daha eski olaylar panel belleğinde tutulmuyor">
          (pencere: son {TIMELINE_LIMIT})
        </span> : null}
        {at === undefined ? null : (
          <span><time>{new Date(at.ts).toLocaleTimeString()}</time> · {at.event}</span>
        )}
        {live ? null : (
          <button type="button" className="linklike" onClick={() => onCursor(total)}>
            Canlıya dön
          </button>
        )}
      </div>
    </div>
  );
}
