// Zaman çizelgesi sekmesi — SALT GÖRÜNÜM (docs/08 → zaman çizelgesi modu).
//
// NEDEN AYRI: App.tsx'in sekme zinciri tek satırda 2251 karakterdi. Monolit
// satır sayısıyla değil, okunabilirlikle ölçülür.
import { TimelineScrubber } from './TimelineScrubber.js';
import type { ReplayEvent } from '../viewmodels/timeline-replay.js';

export function TimelinePanel({ events, cursor, onCursor, visible, at }: {
  readonly events: readonly ReplayEvent[];
  readonly cursor: number;
  readonly onCursor: (next: number) => void;
  readonly visible: readonly ReplayEvent[];
  readonly at: ReplayEvent | undefined;
}) {
  return (
    <>
      <TimelineScrubber events={events} cursor={cursor} onCursor={onCursor} at={at} />
      {/* Boş durumu TimelineScrubber zaten söylüyor; burada tekrar etmek
          aynı mesajı iki kez göstermek olurdu (docs/09 ui_audit boş durumu
          ister, İKİ KEZ istemez). */}
      {visible.length === 0 ? null : (
        <ol className="timeline">
          {/* Ters sıra KASITLI: kullanıcı en son olanı en üstte görmek ister.
              `slice()` şart — reverse() diziyi yerinde çevirir ve kaynağı bozar. */}
          {visible.slice().reverse().map((entry) => (
            <li key={`${entry.cursor}-${entry.event}`}>
              <time>{new Date(entry.ts).toLocaleTimeString()}</time>
              <strong>{entry.event}</strong>
              <code>#{entry.cursor}</code>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
