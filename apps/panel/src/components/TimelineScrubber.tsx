// Zaman çizelgesi kaydırıcısı — SALT GÖRÜNÜM (docs/09 MVVM).
//
// docs/11 Faz 5: "geçmişe kaydırıcıyla dönülür". Panelde yalnızca canlı olay
// listesi vardı; geçmişe dönmek mümkün değildi.
//
// B5: Geçmişte belirgin şerit, önemli olay işaretleri, Canlıya dön butonu.
import { useMemo } from 'react';
import { TIMELINE_LIMIT } from '../viewmodels/workspace-logic.js';
import type { ReplayEvent } from '../viewmodels/timeline-replay.js';

/** Önemli olay tipleri — bunlar çizelgede işaretli nokta olarak gösterilir. */
const MILESTONE_EVENTS: ReadonlySet<string> = new Set([
  'plan_approved', 'plan_created', 'task_escalated', 'task_failed',
  'task_done', 'project_started', 'project_paused',
]);

interface Milestone {
  readonly index: number;
  readonly label: string;
  readonly pct: number;
}

export function TimelineScrubber({ events, cursor, onCursor, at }: {
  readonly events: readonly ReplayEvent[];
  readonly cursor: number;
  readonly onCursor: (cursor: number) => void;
  readonly at: ReplayEvent | undefined;
}) {
  const total = events.length;
  if (total === 0) return <p className="hint">Henüz olay yok.</p>;
  const live = cursor >= total;

  const windowed = total >= TIMELINE_LIMIT;

  // B5 — Önemli olayların pozisyonları
  const milestones = useMemo((): Milestone[] => {
    return events.reduce<Milestone[]>((acc, ev, i) => {
      const evName = typeof ev.event === 'string' ? ev.event : '';
      if (MILESTONE_EVENTS.has(evName)) {
        acc.push({
          index: i,
          label: evName.replace(/_/g, ' '),
          pct: Math.round((i / Math.max(total - 1, 1)) * 100),
        });
      }
      return acc;
    }, []);
  }, [events, total]);

  return (
    <div className={`scrubber${live ? "" : " scrubber--past"}`} aria-label="Zaman çizelgesi kaydırıcısı">
      {/* B5 — GEÇMİŞ şeridi: cursor geçmişteyken belirgin */}
      {!live && (
        <div className="scrubber__past-banner" role="status" aria-live="polite">
          <span className="scrubber__past-label">⏮ Geçmiş Konum</span>
          <span className="scrubber__past-time">
            {at ? new Date(at.ts).toLocaleTimeString() : '—'}
          </span>
          <button
            type="button"
            className="btn btn-secondary scrubber__live-btn"
            onClick={() => onCursor(total)}
          >
            ⚡ Canlıya Dön
          </button>
        </div>
      )}

      <div className="scrubber__track-wrapper">
        <input
          type="range"
          min={0}
          max={total}
          value={Math.min(cursor, total)}
          aria-label="Geçmişte konum"
          onChange={(changeEvent) => onCursor(Number(changeEvent.target.value))}
        />
        {/* B5 — Milestone işaretleri */}
        {milestones.length > 0 && (
          <div className="scrubber__milestones" aria-hidden="true">
            {milestones.map((m) => (
              <button
                key={m.index}
                type="button"
                className="scrubber__milestone-dot"
                style={{ left: `${m.pct}%` }}
                title={m.label}
                onClick={() => onCursor(m.index)}
                aria-label={`${m.label} olayına atla`}
              />
            ))}
          </div>
        )}
      </div>

      <div className="scrubber__meta">
        {/* Canlı mı geçmiş mi olduğu METİNLE yazılır; yalnız renk yeterli değil. */}
        <strong className={live ? "scrubber__badge scrubber__badge--live" : "scrubber__badge scrubber__badge--past"}>{live ? 'CANLI' : 'GEÇMİŞ'}</strong>
        <span>{Math.min(cursor, total)} / {total} olay</span>
        {windowed ? <span title="Daha eski olaylar panel belleğinde tutulmuyor">
          (pencere: son {TIMELINE_LIMIT})
        </span> : null}
        {!live && at !== undefined ? (
          <span><time>{new Date(at.ts).toLocaleTimeString()}</time> · {at.event}</span>
        ) : null}
      </div>
    </div>
  );
}
