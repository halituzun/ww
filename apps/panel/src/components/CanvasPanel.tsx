import React, { useState } from "react";
import type { OrgPlan } from "@ww/shared";
import type { ReplayEvent } from "../viewmodels/timeline-replay.js";
import type { Task } from "../services/projects.js";
import { AgentCanvas } from "./AgentCanvas.js";
import { TaskCanvas } from "./TaskCanvas.js";
import { GanttChart } from "./GanttChart.js";
import { CouncilTranscriptViewer, parseTranscriptFromMarkdown } from "./CouncilTranscriptViewer.js";
import { TimelineScrubber } from "./TimelineScrubber.js";
import { AgentDetail } from "./AgentDetail.js";
import { ProjectMapPanel } from "./ProjectMapPanel.js";

export type CanvasTab = "org" | "tasks" | "gantt" | "council" | "map";

export interface CanvasPanelProps {
  readonly projectId: string;
  readonly orgPlan?: OrgPlan | undefined;
  readonly tasks?: readonly Task[] | undefined;
  readonly transcript?: any[] | undefined;
  readonly plans?: readonly any[] | undefined;
  readonly planContentMd?: string | undefined;
  readonly events?: readonly ReplayEvent[] | undefined;
  readonly cursor?: number | undefined;
  readonly onCursor?: ((cursor: number) => void) | undefined;
  readonly at?: ReplayEvent | undefined;
  readonly statusByTask?: ReadonlyMap<string, string> | undefined;
  readonly selectedAgent?: string | undefined;
  readonly onSelectAgent?: ((agentId: string | undefined) => void) | undefined;
}

export function buildTranscriptFromPlan(plan: any, contentMd?: string): any[] | undefined {
  if (contentMd) {
    const fromMd = parseTranscriptFromMarkdown(contentMd);
    if (fromMd && fromMd.length > 0) return fromMd;
  }
  if (!plan) return undefined;
  if (plan.transcript && Array.isArray(plan.transcript) && plan.transcript.length > 0) {
    return plan.transcript;
  }
  if (plan.content_md) {
    const fromMd = parseTranscriptFromMarkdown(plan.content_md);
    if (fromMd && fromMd.length > 0) return fromMd;
  }
  return undefined;
}

export function CanvasPanel({
  projectId,
  orgPlan,
  tasks = [],
  transcript,
  plans = [],
  planContentMd,
  events = [],
  cursor = Number.POSITIVE_INFINITY,
  onCursor,
  at,
  statusByTask,
  selectedAgent: controlledSelectedAgent,
  onSelectAgent,
}: CanvasPanelProps) {
  const getInitialTab = (): CanvasTab => {
    try {
      const search = window.location.search || "";
      const hash = window.location.hash || "";
      const params = new URLSearchParams(
        search.startsWith("?") ? search : (hash.includes("?") ? hash.slice(hash.indexOf("?")) : "")
      );
      const tabParam = params.get("tab");
      if (tabParam === "council" || tabParam === "gantt" || tabParam === "tasks" || tabParam === "org" || tabParam === "map") {
        return tabParam as CanvasTab;
      }
    } catch {}
    return "org";
  };

  const [activeTab, setActiveTab] = useState<CanvasTab>(getInitialTab());
  const [localSelectedAgent, setLocalSelectedAgent] = useState<string | undefined>(undefined);

  const activePlan = plans[0];
  const effectiveTranscript = transcript || buildTranscriptFromPlan(activePlan, planContentMd ?? activePlan?.content_md);
  const selectedAgent = controlledSelectedAgent ?? localSelectedAgent;
  const selectAgent = (agentId: string | undefined): void => {
    setLocalSelectedAgent(agentId);
    onSelectAgent?.(agentId);
  };

  const showSidebar = (activeTab === "org" || activeTab === "tasks") && selectedAgent !== undefined;

  const tabStyle = (tab: CanvasTab): React.CSSProperties => {
    const isActive = activeTab === tab;
    return {
      padding: "8px 16px",
      fontSize: 13,
      fontWeight: isActive ? 600 : 500,
      color: isActive ? "#38bdf8" : "#94a3b8",
      backgroundColor: isActive ? "rgba(56, 189, 248, 0.12)" : "rgba(30, 41, 59, 0.6)",
      border: isActive ? "1px solid rgba(56, 189, 248, 0.5)" : "1px solid rgba(148, 163, 184, 0.15)",
      borderRadius: 8,
      cursor: "pointer",
      transition: "all 0.15s ease",
      boxShadow: isActive ? "0 0 12px rgba(56, 189, 248, 0.15)" : "none",
    };
  };

  return (
    <div className="canvas-panel-page" style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <div className="canvas-header-row" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px" }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 600, color: "#f8fafc", margin: "0 0 4px 0" }}>
            Canlı Tuval
          </h2>
          <p style={{ fontSize: 13, color: "#94a3b8", margin: 0 }}>
            Agent hiyerarşisi, aktif iş akışı ve zaman çizelgesi
          </p>
        </div>

        <div className="canvas-tab-pills" role="tablist" aria-label="Tuval Görünümleri" style={{ display: "flex", gap: "8px", background: "rgba(15, 23, 42, 0.6)", padding: "4px", borderRadius: "10px", border: "1px solid rgba(148, 163, 184, 0.1)" }}>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "org"}
            style={tabStyle("org")}
            onClick={() => setActiveTab("org")}
          >
            Agent Organizasyonu
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "tasks"}
            style={tabStyle("tasks")}
            onClick={() => setActiveTab("tasks")}
          >
            Görev Akışı
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "gantt"}
            style={tabStyle("gantt")}
            onClick={() => setActiveTab("gantt")}
          >
            Zaman Planı
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "council"}
            style={tabStyle("council")}
            onClick={() => setActiveTab("council")}
          >
            Konsey Müzakeresi
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "map"}
            style={tabStyle("map")}
            onClick={() => setActiveTab("map")}
          >
            Proje Haritası
          </button>
        </div>

        <div className="canvas-legend-row" style={{ display: "flex", gap: "12px", alignItems: "center", fontSize: 12, color: "#94a3b8" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: "#10b981", boxShadow: "0 0 6px #10b981" }} /> boşta
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: "#38bdf8", boxShadow: "0 0 6px #38bdf8" }} /> meşgul
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: "#f59e0b", boxShadow: "0 0 6px #f59e0b" }} /> bekliyor
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: "#ef4444", boxShadow: "0 0 6px #ef4444" }} /> tırmandı
          </span>
        </div>
      </div>

      {events.length > 0 && (
        <div className="canvas-scrubber-bar">
          <TimelineScrubber
            events={events}
            cursor={cursor}
            onCursor={onCursor ?? (() => undefined)}
            at={at}
          />
        </div>
      )}

      <div
        className="canvas-body-layout"
        style={{
          display: "grid",
          gridTemplateColumns: showSidebar ? "1fr 340px" : "1fr",
          gap: "16px",
          alignItems: "start",
        }}
      >
        <div className="canvas-main-col" style={{ minWidth: 0 }}>
          <div className="canvas-viewport-card" style={{ background: "transparent", border: "none" }}>
            {activeTab === "org" && (
              <AgentCanvas
                projectId={projectId}
                orgPlan={orgPlan}
                onSelectAgent={selectAgent}
              />
            )}
            {activeTab === "tasks" && (
              <TaskCanvas tasks={tasks} statusByTask={statusByTask} />
            )}
            {activeTab === "gantt" && (
              <GanttChart tasks={tasks} orgPlan={orgPlan} />
            )}
            {activeTab === "council" && (
              <CouncilTranscriptViewer
                projectId={projectId}
                transcript={effectiveTranscript}
                planContentMd={planContentMd ?? activePlan?.content_md}
              />
            )}
            {activeTab === "map" && (
              <ProjectMapPanel projectId={projectId} />
            )}
          </div>
        </div>

        {showSidebar && (
          <aside className="canvas-sidebar-col">
            <AgentDetail projectId={projectId} agentId={selectedAgent} />
          </aside>
        )}
      </div>
    </div>
  );
}
