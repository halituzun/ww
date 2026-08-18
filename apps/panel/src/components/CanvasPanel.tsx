// Tuval sekmesi — SALT GÖRÜNÜM (docs/08 → canlı tuval + zaman çizelgesi modu).
//
// NEDEN AYRI: App.tsx'in sekme zinciri tek satırda 2251 karakterdi.
import { TimelineScrubber } from './TimelineScrubber.js';
import { AgentCanvas } from './AgentCanvas.js';
import { AgentDetail } from './AgentDetail.js';
import { TaskCanvas } from './TaskCanvas.js';
import type { ReplayEvent } from '../viewmodels/timeline-replay.js';
import type { Task } from '../services/projects.js';

export function CanvasPanel({
  projectId, events, cursor, onCursor, at,
  tasks, statusByTask, selectedAgent, onSelectAgent,
}: {
  readonly projectId: string;
  readonly events: readonly ReplayEvent[];
  readonly cursor: number;
  readonly onCursor: (next: number) => void;
  readonly at: ReplayEvent | undefined;
  readonly tasks: readonly Task[];
  /**
   * Geçmişe kaydırıldığında O ANKİ durumlar; canlıdayken `undefined` verilir
   * ve tuval güncel durumu çizer. Karıştırmak, geçmişi canlı gibi
   * göstermek olurdu.
   */
  readonly statusByTask: ReadonlyMap<string, string> | undefined;
  readonly selectedAgent: string | undefined;
  readonly onSelectAgent: (agentId: string) => void;
}) {
  return (
    <>
      <TimelineScrubber events={events} cursor={cursor} onCursor={onCursor} at={at} />
      <AgentCanvas projectId={projectId} onSelectAgent={onSelectAgent} />
      <AgentDetail projectId={projectId} agentId={selectedAgent} />
      <TaskCanvas tasks={tasks} statusByTask={statusByTask} />
    </>
  );
}
