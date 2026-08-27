import React, { useState } from "react";
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
  const [viewMode, setViewMode] = useState<"agents" | "tasks">("agents");

  return (
    <div className="canvas-page">
      <div className="canvas-page-header">
        <div>
          <h2>Canlı Tuval</h2>
          <p className="hint">Agent hiyerarşisi, aktif iş akışı ve zaman çizelgesi</p>
        </div>

        <div className="canvas-header-controls">
          {/* Sekme geçişi: Agent Organizasyonu / Görev Akışı */}
          <div className="canvas-view-toggle" role="tablist" aria-label="Tuval görünümü">
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === "agents"}
              className={`canvas-toggle-btn ${viewMode === "agents" ? "canvas-toggle-btn--active" : ""}`}
              onClick={() => setViewMode("agents")}
            >
              Agent Organizasyonu
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === "tasks"}
              className={`canvas-toggle-btn ${viewMode === "tasks" ? "canvas-toggle-btn--active" : ""}`}
              onClick={() => setViewMode("tasks")}
            >
              Görev Akışı
            </button>
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
      </div>

      <div className="canvas-page-grid">
        <div className="canvas-main-col">
          {events.length > 0 ? <TimelineScrubber events={events} cursor={cursor} onCursor={onCursor} at={at} /> : null}
          
          <div className="canvas-card">
            {viewMode === "agents" ? (
              <AgentCanvas projectId={projectId} onSelectAgent={onSelectAgent} />
            ) : (
              <TaskCanvas tasks={tasks} statusByTask={statusByTask} />
            )}
          </div>
        </div>

        <aside className="canvas-sidebar-col">
          <AgentDetail projectId={projectId} agentId={selectedAgent} />
        </aside>
      </div>
    </div>
  );
}
