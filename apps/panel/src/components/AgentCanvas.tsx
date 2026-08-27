// Canlı tuval — SALT GÖRÜNÜM (docs/08 → agent organizasyon şeması).
//
// Düğümler agent'lardır; oklar gerçek ilişkilerden gelir. Düğüm konumları
// hiyerarşiden türetilir: PM üstte, grup liderleri ortada, üyeler altta.
// Klonlar kaynaklarının yanında ve yarı saydam çizilir (T4).
import React from "react";
import { agentRoleLabel, agentStatusLabel } from "../services/labels.js";
import { Background, Controls, ReactFlow, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCanvasViewModel, type RoleFilter } from "../viewmodels/useCanvasViewModel.js";
import type { CanvasNode } from "../services/canvas.js";

// B2 — Takılma uyarı rengi: tek yerden alınır.
const STUCK_COLOR = "#f59e0b";

const STATUS_COLOR: Record<string, string> = {
  idle: "#10b981",
  busy: "#3b82f6",
  waiting_verify: "#f59e0b",
  waiting_answer: "#f59e0b",
  escalated: "#ef4444",
  stopped: "#64748b",
};

// B3 — Ok türü renk ve kalınlıkları
const EDGE_STYLE: Record<string, { stroke: string; strokeWidth: number }> = {
  hierarchy: { stroke: "#94a3b8", strokeWidth: 1.8 },
  assignment: { stroke: "#34d399", strokeWidth: 2.5 },
  verification: { stroke: "#f59e0b", strokeWidth: 2.5 },
  clone: { stroke: "#a855f7", strokeWidth: 1.8 },
};

/** Geçen süreyi okunabilir kısa metne çevirir (ör. "3 dk 12 sn"). */
function formatElapsed(sec: number | undefined): string {
  if (sec === undefined || sec === null || !Number.isFinite(sec)) return "süre bilinmiyor";
  if (sec < 60) return `${sec} sn`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s > 0 ? `${m} dk ${s} sn` : `${m} dk`;
}

/** Model referansından kısa model adı çıkar (ör. "ollama:qwen3.6:latest" → "qwen3.6"). */
function cleanModelName(modelRef: string | undefined): string {
  if (!modelRef || modelRef === "" || modelRef === "unknown") return "model bilinmiyor";
  // ollama:deepseek-coder:33b -> deepseek-33b
  // ollama:qwen2.5-coder:7b -> qwen-7b
  // ollama:qwen3.6:latest -> qwen3.6
  // deepseek:deepseek-chat -> deepseek-chat
  if (modelRef.includes("deepseek-coder:33b")) return "deepseek-33b";
  if (modelRef.includes("qwen2.5-coder:7b")) return "qwen-7b";
  if (modelRef.includes("qwen3.6")) return "qwen3.6";
  if (modelRef.includes("deepseek-chat")) return "deepseek-chat";

  const parts = modelRef.split(":");
  if (parts.length >= 2) {
    const name = parts[1] ?? parts[0];
    if (parts.length >= 3 && parts[2] !== "latest") {
      return `${name.replace("-coder", "")}-${parts[2]}`;
    }
    return name.replace("-coder", "");
  }
  return modelRef.slice(0, 20);
}

/**
 * Hiyerarşik düğüm yerleşimi (T4):
 * - Seviye 0 (Y: 40): PM
 * - Seviye 1 (Y: 180): Grup liderleri / Konsey / Görüşmeci
 * - Seviye 2 (Y: 340): İşçi, Denetçi, Araştırmacı vb.
 * - Klonlar: Kaynak düğümün yanında (+60px X, +35px Y) ve yarı saydam.
 */
export function computeHierarchicalPositions(
  nodes: readonly CanvasNode[]
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  const nonClones = nodes.filter((n) => !n.cloneOf);
  const clones = nodes.filter((n) => Boolean(n.cloneOf));

  const pmNodes = nonClones.filter((n) => n.role === "pm");
  const sideRoles = nonClones.filter((n) => n.role === "interviewer" || n.role === "researcher");
  const groupLeads = nonClones.filter((n) => n.role === "group_lead" || n.role === "council_member");
  const executionNodes = nonClones.filter(
    (n) => n.role !== "pm" && n.role !== "interviewer" && n.role !== "researcher" && n.role !== "group_lead" && n.role !== "council_member"
  );

  // Seviye 0: PM (Ortada)
  pmNodes.forEach((node, idx) => {
    positions.set(node.id, { x: 400 + idx * 240, y: 40 });
  });

  // Seviye 1: Yan roller (Görüşmeci sol dış kanatta X: 60) ve Grup Liderleri (ortada/sağda)
  sideRoles.forEach((node, idx) => {
    positions.set(node.id, { x: 60 + idx * 240, y: 180 });
  });
  groupLeads.forEach((node, idx) => {
    positions.set(node.id, { x: 420 + idx * 260, y: 180 });
  });

  // Seviye 2: Yapanlar ve Denetleyenler (Geniş alt katman, X: 40, 290, 540, 790)
  const execSpacing = 250;
  const execStartX = 40;
  executionNodes.forEach((node, idx) => {
    positions.set(node.id, { x: execStartX + idx * execSpacing, y: 340 });
  });

  // Klonları kaynaklarının yanına yerleştir
  for (const clone of clones) {
    const parentPos = clone.cloneOf ? positions.get(clone.cloneOf) : undefined;
    if (parentPos) {
      positions.set(clone.id, { x: parentPos.x + 60, y: parentPos.y + 35 });
    } else {
      positions.set(clone.id, { x: 400, y: 340 });
    }
  }

  return positions;
}

// B4 — Rol filtresi butonu bileşeni
function RoleFilterBar({ value, onChange }: {
  readonly value: RoleFilter;
  readonly onChange: (v: RoleFilter) => void;
}) {
  const options: { key: RoleFilter; label: string }[] = [
    { key: "all", label: "Hepsi" },
    { key: "workers", label: "Yapanlar" },
    { key: "verifiers", label: "Denetleyenler" },
  ];
  return (
    <div className="canvas-role-filter" role="group" aria-label="Rol filtresi">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          className={`canvas-filter-btn${value === o.key ? " canvas-filter-btn--active" : ""}`}
          onClick={() => onChange(o.key)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function AgentCanvas({
  projectId,
  onSelectAgent,
}: {
  readonly projectId: string;
  /** docs/08: düğüme tık → agent geçmişi. */
  readonly onSelectAgent?: ((agentId: string) => void) | undefined;
}) {
  const {
    data, rawData, error,
    roleFilter, setRoleFilter,
    selectedNodeId, setSelectedNodeId, clearSelection,
    highlightSet,
  } = useCanvasViewModel(projectId);

  // B6 — Boş/hata durumları
  if (error !== "") return <p className="canvas__error">{error}</p>;

  if (rawData.nodes.length === 0) {
    return (
      <div className="canvas__empty-state" aria-live="polite">
        <p className="canvas__empty-title">Bu projede henüz agent yok</p>
        <p className="canvas__empty-desc hint">
          Plan onaylanmamış veya proje duraklatılmış olabilir.
        </p>
      </div>
    );
  }

  const positions = computeHierarchicalPositions(data.nodes);

  const nodes = data.nodes.map((node) => {
    const pos = positions.get(node.id) ?? { x: 100, y: 100 };
    const isSelected = selectedNodeId === node.id;
    const isDimmed = highlightSet !== undefined && !highlightSet.has(node.id);
    const isStuck = Boolean(node.stuckReason);
    const isBusy = node.status === "busy" || node.status === "waiting_verify" || node.status === "waiting_answer";

    // B1 — Düğüm içeriği (EMOJİ YOK!):
    // 1. Satır: İsim · Rol
    // 2. Satır: Görev başlığı veya Durum + Süre
    // 3. Satır: Model adı
    const roleText = agentRoleLabel(node.role);
    const statusText = agentStatusLabel(node.status);
    const elapsedText = formatElapsed(node.elapsedSec);
    const modelText = cleanModelName(node.modelRef);

    const line1 = node.label;
    const line2 = `${roleText} · ${statusText}${elapsedText ? ` · ${elapsedText}` : ""}${node.unresponsive ? " · yanıt vermiyor" : ""}`;
    const line3 = node.currentTaskTitle ? `Görev: ${node.currentTaskTitle.slice(0, 32)}` : "";
    const line4 = `Model: ${modelText}`;
    const line5 = node.stuckReason ? `Takılı: ${node.stuckReason}` : "";

    const labelParts = [line1, line2, line3, line4, line5].filter(Boolean);

    // B2 — Renk: takılıysa uyarı sarısı (#f59e0b), yoksa durum rengi
    const borderColor = isStuck
      ? STUCK_COLOR
      : (node.unresponsive ? "#ef4444" : STATUS_COLOR[node.status] ?? "#64748b");
    const borderStyle = (node.unresponsive || isStuck) ? "dashed" : "solid";

    return {
      id: node.id,
      position: pos,
      data: { label: labelParts.join(String.fromCharCode(10)) },
      style: {
        background: isSelected ? "#1e293b" : "#0f172a",
        border: `${isSelected ? "2.5" : "2"}px ${borderStyle} ${borderColor}`,
        borderRadius: 10,
        color: isDimmed ? "#475569" : "#f1f5f9",
        padding: "10px 14px",
        whiteSpace: "pre-line",
        opacity: isDimmed ? 0.35 : (node.cloneOf === undefined ? 1 : 0.75),
        fontSize: 12,
        lineHeight: 1.45,
        minWidth: 220,
        boxShadow: isBusy && !isDimmed ? `0 0 12px 2px ${borderColor}33` : "0 4px 12px rgba(0,0,0,0.3)",
        transition: "opacity 0.2s, box-shadow 0.2s, border-color 0.2s",
      },
      className: isBusy && !isDimmed ? "canvas-node--pulse" : undefined,
    };
  });

  const edges = data.edges.map((edge) => {
    const style = EDGE_STYLE[edge.kind] ?? { stroke: "#64748b", strokeWidth: 1.5 };
    const isDimmed = highlightSet !== undefined
      && !highlightSet.has(edge.source) && !highlightSet.has(edge.target);
    const showLabel = edge.kind !== "hierarchy" && edge.kind !== "clone";
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: edge.kind === "hierarchy" ? "bezier" : "smoothstep",
      animated: edge.animated,
      label: showLabel ? edge.label : undefined,
      style: {
        stroke: isDimmed ? "#1e293b" : style.stroke,
        strokeWidth: isDimmed ? 1 : style.strokeWidth,
        transition: "stroke 0.2s, stroke-width 0.2s",
      },
      labelStyle: {
        fill: isDimmed ? "#334155" : "#e2e8f0",
        fontSize: 11,
        fontWeight: 500,
      },
      labelBgStyle: {
        fill: "#0b111c",
        fillOpacity: 0.95,
        rx: 4,
        ry: 4,
        stroke: "rgba(255, 255, 255, 0.14)",
        strokeWidth: 1,
      },
      labelBgPadding: [6, 4] as [number, number],
      markerEnd: {
        type: "arrowclosed" as never,
        color: isDimmed ? "#1e293b" : style.stroke,
        width: edge.kind === "hierarchy" ? 12 : 16,
        height: edge.kind === "hierarchy" ? 12 : 16,
      },
    };
  });

  return (
    <div className="flow-canvas-wrapper">
      <RoleFilterBar value={roleFilter} onChange={setRoleFilter} />
      <div
        className="flow-canvas"
        onClick={(e) => {
          if ((e.target as HTMLElement).closest(".react-flow__node") === null) clearSelection();
        }}
      >
        <ReactFlow
          nodes={nodes as never}
          edges={edges as never}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          proOptions={{ hideAttribution: true }}
          onNodeClick={(_event, node) => {
            setSelectedNodeId((prev) => (prev === node.id ? undefined : node.id));
            onSelectAgent?.(node.id);
          }}
        >
          <Background color="#1e293b" gap={16} />
          {/* Controls sağ altta, karanlık temaya uygun */}
          <Controls position="bottom-right" className="canvas-controls" showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  );
}
