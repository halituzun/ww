import React, { useRef, useState, useEffect } from "react";
import type { Task } from "../services/projects.js";
import type { OrgPlan } from "@ww/shared";
import { useGanttViewModel } from "../viewmodels/useGanttViewModel.js";
import { formatElapsed } from "../services/labels.js";

export function GanttChart({
  tasks,
  orgPlan,
  onSelectTask,
}: {
  readonly tasks: readonly Task[];
  readonly orgPlan?: OrgPlan | undefined;
  readonly onSelectTask?: ((taskId: string) => void) | undefined;
}) {
  const { groups, totalMinutes, currentMinute } = useGanttViewModel(tasks, orgPlan);
  const containerRef = useRef<HTMLDivElement>(null);
  const [rowCoords, setRowCoords] = useState<Map<string, { top: number; left: number; right: number; height: number }>>(new Map());

  // Satır koordinatlarını hesaplayarak SVG bağımlılık oklarını bağla
  useEffect(() => {
    if (!containerRef.current) return;
    const map = new Map<string, { top: number; left: number; right: number; height: number }>();
    const rootRect = containerRef.current.getBoundingClientRect();

    const barEls = containerRef.current.querySelectorAll<HTMLElement>("[data-gantt-task-id]");
    barEls.forEach((el) => {
      const taskId = el.getAttribute("data-gantt-task-id");
      if (!taskId) return;
      const rect = el.getBoundingClientRect();
      map.set(taskId, {
        top: rect.top - rootRect.top + rect.height / 2,
        left: rect.left - rootRect.left,
        right: rect.right - rootRect.left,
        height: rect.height,
      });
    });
    setRowCoords(map);
  }, [groups, totalMinutes]);

  const timeTicks: number[] = [];
  const tickStep = totalMinutes <= 40 ? 5 : 10;
  for (let m = 0; m <= totalMinutes; m += tickStep) {
    timeTicks.push(m);
  }

  const nowLeftPct = Math.min(100, Math.max(0, (currentMinute / totalMinutes) * 100));

  if (groups.length === 0) {
    return (
      <div className="gantt-empty-state" style={{ padding: "32px 24px", textAlign: "center", color: "#94a3b8" }}>
        <p style={{ margin: 0, fontSize: "13px" }}>Henüz planlanmış veya çalışan bir görev bulunmuyor.</p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="gantt-container"
      style={{
        position: "relative",
        background: "rgba(15, 23, 42, 0.7)",
        border: "1px solid rgba(255, 255, 255, 0.08)",
        borderRadius: "12px",
        overflow: "hidden",
        fontFamily: "inherit",
        boxShadow: "0 8px 32px rgba(0, 0, 0, 0.3)",
      }}
    >
      {/* Üst Zaman Cetveli */}
      <div
        className="gantt-timeline-header"
        style={{
          display: "grid",
          gridTemplateColumns: "280px 1fr",
          borderBottom: "1px solid rgba(255, 255, 255, 0.08)",
          background: "rgba(30, 41, 59, 0.4)",
          padding: "10px 0",
          fontSize: "11px",
          color: "#94a3b8",
          fontWeight: 600,
        }}
      >
        <div style={{ padding: "0 16px" }}>Görev & Sorumlu Agent</div>
        <div style={{ position: "relative", height: "20px", marginRight: "48px", paddingRight: "16px" }}>
          {timeTicks.map((tick) => {
            const leftPct = (tick / totalMinutes) * 100;
            const isLast = tick === totalMinutes || (totalMinutes - tick < tickStep / 2);
            return (
              <div
                key={tick}
                style={{
                  position: "absolute",
                  left: `${leftPct}%`,
                  transform: isLast ? "translateX(-100%)" : (tick === 0 ? "none" : "translateX(-50%)"),
                  fontSize: "11px",
                  color: "#94a3b8",
                  fontWeight: 500,
                  whiteSpace: "nowrap",
                  userSelect: "none",
                }}
              >
                {tick} dk
              </div>
            );
          })}
        </div>
      </div>

      {/* Ana Çizelge Gövdesi */}
      <div className="gantt-body" style={{ position: "relative" }}>
        {/* Dikey Izgara Çizgileri Katmanı */}
        <div
          className="gantt-grid-lines"
          style={{
            position: "absolute",
            top: 0,
            left: "280px",
            right: "48px",
            bottom: 0,
            pointerEvents: "none",
          }}
        >
          {timeTicks.map((tick) => {
            const leftPct = (tick / totalMinutes) * 100;
            return (
              <div
                key={tick}
                style={{
                  position: "absolute",
                  left: `${leftPct}%`,
                  top: 0,
                  bottom: 0,
                  width: "1px",
                  background: "rgba(255, 255, 255, 0.04)",
                }}
              />
            );
          })}
          {/* Canlı ŞİMDİ Dikey Çizgisi */}
          <div
            className="gantt-now-line"
            style={{
              position: "absolute",
              left: `${nowLeftPct}%`,
              top: 0,
              bottom: 0,
              width: "2px",
              background: "#f59e0b",
              boxShadow: "0 0 8px #f59e0b88",
              zIndex: 5,
            }}
          >
            <span
              style={{
                position: "absolute",
                top: "2px",
                left: "4px",
                background: "#f59e0b",
                color: "#0f172a",
                fontSize: "9px",
                fontWeight: 700,
                padding: "1px 4px",
                borderRadius: "3px",
                whiteSpace: "nowrap",
              }}
            >
              ŞİMDİ ({currentMinute} dk)
            </span>
          </div>
        </div>

        {/* Departman Grupları */}
        {groups.map((group) => (
          <div key={group.id} className="gantt-dept-section">
            <div
              className="gantt-dept-title"
              style={{
                background: "rgba(30, 41, 59, 0.4)",
                padding: "6px 16px",
                fontSize: "11px",
                fontWeight: 600,
                color: "#38bdf8",
                borderBottom: "1px solid rgba(255,255,255,0.06)",
                borderTop: "1px solid rgba(255,255,255,0.06)",
                letterSpacing: "0.3px",
              }}
            >
              {group.name}
            </div>

            {group.tasks.map((task) => {
              const startPct = (task.startMin / totalMinutes) * 100;
              const widthPct = Math.max(6, (task.durationMin / totalMinutes) * 100);

              const isDone = task.status === "done";
              const isRunning = task.isRunning || task.status === "working" || task.status === "in_progress";
              const isQueued = task.isQueued || task.status === "queued" || task.status === "pending" || (!isDone && !isRunning);

              let barBg = "transparent";
              let barBorder = "1.5px dashed rgba(148, 163, 184, 0.5)";
              let barTextColor = "#94a3b8";

              if (isDone) {
                barBg = "linear-gradient(90deg, #0284c7 0%, #0369a1 100%)";
                barBorder = "1px solid #38bdf8";
                barTextColor = "#ffffff";
              } else if (isRunning) {
                barBg = "linear-gradient(90deg, #10b981 0%, #059669 100%)";
                barBorder = "1px solid #34d399";
                barTextColor = "#ffffff";
              } else if (isQueued) {
                // Kesikli slot görünümü
                barBg = "rgba(30, 41, 59, 0.25)";
                barBorder = "1.5px dashed rgba(148, 163, 184, 0.5)";
                barTextColor = "#94a3b8";
              }

              return (
                <div
                  key={task.taskId}
                  className="gantt-task-row"
                  style={{
                    display: "grid",
                    gridTemplateColumns: "280px 1fr",
                    height: "44px",
                    borderBottom: "1px solid rgba(255,255,255,0.04)",
                    alignItems: "center",
                  }}
                >
                  {/* Sol Bilgi Kartı */}
                  <div
                    style={{
                      padding: "0 16px",
                      display: "flex",
                      flexDirection: "column",
                      justifyContent: "center",
                      borderRight: "1px solid rgba(255,255,255,0.08)",
                      cursor: onSelectTask ? "pointer" : "default",
                      overflow: "hidden",
                    }}
                    onClick={() => onSelectTask?.(task.taskId)}
                  >
                    <div style={{ fontSize: "12px", color: "#f1f5f9", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {task.title}
                    </div>
                    <div style={{ fontSize: "10px", color: "#94a3b8", display: "flex", gap: "6px", alignItems: "center" }}>
                      <span style={{ color: "#38bdf8" }}>{task.assignedRole}</span>
                      <span>·</span>
                      <span>{task.assignedModel}</span>
                      <span>·</span>
                      <span className={`status-pill status-pill--${task.status}`}>{task.statusLabel}</span>
                    </div>
                  </div>

                  {/* Sağ Çubuk Alanı */}
                  <div style={{ position: "relative", height: "100%", display: "flex", alignItems: "center", marginRight: "48px" }}>
                    <div
                      data-gantt-task-id={task.taskId}
                      className={`gantt-bar ${isRunning ? "gantt-bar--pulse" : ""} ${isQueued ? "gantt-bar--queued" : ""}`}
                      style={{
                        position: "absolute",
                        left: `${startPct}%`,
                        width: `${widthPct}%`,
                        height: "24px",
                        background: barBg,
                        border: barBorder,
                        borderRadius: "6px",
                        boxShadow: isRunning ? "0 0 10px rgba(16, 185, 129, 0.4)" : "none",
                        display: "flex",
                        alignItems: "center",
                        padding: "0 8px",
                        fontSize: "10px",
                        color: barTextColor,
                        fontWeight: 600,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        zIndex: 2,
                        cursor: onSelectTask ? "pointer" : "default",
                      }}
                      onClick={() => onSelectTask?.(task.taskId)}
                      title={`${task.title} (${task.statusLabel})`}
                    >
                      {isQueued ? `Planlanan slot: ${task.durationMin} dk` : (isRunning ? `%${task.progressPct} · ${formatElapsed(task.durationMin * 60)}` : formatElapsed(task.durationMin * 60))}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ))}

        {/* SVG Bağımlılık Okları Katmanı */}
        <svg
          className="gantt-dependencies-svg"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            pointerEvents: "none",
            zIndex: 4,
          }}
        >
          {groups.flatMap((g) => g.tasks).map((task) => {
            const targetCoord = rowCoords.get(task.taskId);
            if (!targetCoord) return null;

            return task.dependsOn.map((depId) => {
              const sourceCoord = rowCoords.get(depId);
              if (!sourceCoord) return null;

              const startX = sourceCoord.right;
              const startY = sourceCoord.top;
              const endX = targetCoord.left;
              const endY = targetCoord.top;

              const cX1 = startX + (endX - startX) * 0.5;
              const cY1 = startY;
              const cX2 = startX + (endX - startX) * 0.5;
              const cY2 = endY;

              const pathD = `M ${startX} ${startY} C ${cX1} ${cY1}, ${cX2} ${cY2}, ${endX} ${endY}`;

              return (
                <g key={`gantt-edge-${depId}-${task.taskId}`}>
                  <path
                    d={pathD}
                    fill="none"
                    stroke="#38bdf8"
                    strokeWidth="1.6"
                    strokeDasharray="4,4"
                  />
                  <circle cx={endX} cy={endY} r="3" fill="#38bdf8" />
                </g>
              );
            });
          })}
        </svg>
      </div>
    
      {/* F3 — Departman Bazlı Metrik & Özet Kartları */}
      <div
        className="gantt-dept-summaries"
        style={{
          marginTop: "16px",
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: "12px",
        }}
      >
        {groups.map((group) => {
          const totalTasks = group.tasks.length;
          const doneTasks = group.tasks.filter((t) => t.status === "done").length;
          const runningTasks = group.tasks.filter((t) => t.isRunning || t.status === "working" || t.status === "in_progress").length;
          const queuedTasks = totalTasks - doneTasks - runningTasks;
          const totalPlannedMin = group.tasks.reduce((sum, t) => sum + t.durationMin, 0);

          return (
            <div
              key={`summary-${group.id}`}
              className="gantt-summary-card"
              style={{
                background: "rgba(15, 23, 42, 0.6)",
                border: "1px solid rgba(148, 163, 184, 0.15)",
                borderRadius: "10px",
                padding: "12px 16px",
                display: "flex",
                flexDirection: "column",
                gap: "8px",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: "12px", fontWeight: 600, color: "#38bdf8" }}>{group.name}</span>
                <span style={{ fontSize: "11px", color: "#94a3b8" }}>{totalTasks} Görev · {totalPlannedMin} dk</span>
              </div>

              <div style={{ display: "flex", gap: "12px", fontSize: "11px" }}>
                <span style={{ color: "#10b981", display: "inline-flex", alignItems: "center", gap: 4 }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#10b981" }} />
                  {doneTasks} Bitti
                </span>
                <span style={{ color: "#38bdf8", display: "inline-flex", alignItems: "center", gap: 4 }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#38bdf8" }} />
                  {runningTasks} Aktif
                </span>
                <span style={{ color: "#f59e0b", display: "inline-flex", alignItems: "center", gap: 4 }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#f59e0b" }} />
                  {queuedTasks} Kuyrukta
                </span>
              </div>

              <div style={{ fontSize: "11px", color: "#64748b", borderTop: "1px solid rgba(255,255,255,0.05)", paddingTop: "6px" }}>
                {totalTasks === 1
                  ? "Bu departmanda 1 planlı görev var. Görevler eklendikçe zaman planı zenginleşir."
                  : `${totalTasks} görev planlandı. İş akışı başladığında canlı süre gerçekleşmeleri güncellenir.`}
              </div>
            </div>
          );
        })}
      </div>
</div>
  );
}
