import { TimelineScrubber } from "./TimelineScrubber.js";
import { AgentCanvas } from "./AgentCanvas.js";
import { AgentDetail } from "./AgentDetail.js";
import { TaskCanvas } from "./TaskCanvas.js";
import type { ReplayEvent } from "../viewmodels/timeline-replay.js";
import type { Task } from "../services/projects.js";

export function CanvasPanel({
  projectId,
  events,
  cursor,
  onCursor,
  at,
  tasks,
  statusByTask,
  selectedAgent,
  onSelectAgent,
}: {
  readonly projectId: string;
  readonly events: readonly ReplayEvent[];
  readonly cursor: number;
  readonly onCursor: (next: number) => void;
  readonly at: ReplayEvent | undefined;
  readonly tasks: readonly Task[];
  readonly statusByTask: ReadonlyMap<string, string> | undefined;
  readonly selectedAgent: string | undefined;
  readonly onSelectAgent: (agentId: string) => void;
}) {
  return (
    <div className="canvas-page">
      <div className="canvas-page-header">
        <div>
          <h2>Canlı Tuval</h2>
          <p className="hint">Agent hiyerarşisi, aktif iş akışı ve zaman çizelgesi</p>
        </div>
        <div className="canvas-legend">
          <span className="legend-item">
            <i className="dot dot--idle" />
            boşta
          </span>
          <span className="legend-item">
            <i className="dot dot--busy" />
            meşgul
          </span>
          <span className="legend-item">
            <i className="dot dot--waiting" />
            bekliyor
          </span>
          <span className="legend-item">
            <i className="dot dot--escalated" />
            tırmandı
          </span>
        </div>
      </div>

      <div className="canvas-page-grid">
        <div className="canvas-main-col">
          <TimelineScrubber events={events} cursor={cursor} onCursor={onCursor} at={at} />
          <div className="canvas-card">
            <h3>Agent Organizasyon Tuvali</h3>
            <AgentCanvas projectId={projectId} onSelectAgent={onSelectAgent} />
          </div>
          <div className="canvas-card">
            <h3>Görev Akış Tuvali</h3>
            <TaskCanvas tasks={tasks} statusByTask={statusByTask} />
          </div>
        </div>

        <aside className="canvas-sidebar-col">
          <AgentDetail projectId={projectId} agentId={selectedAgent} />
        </aside>
      </div>
    </div>
  );
}
