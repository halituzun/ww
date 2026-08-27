// Canlı tuval — SALT GÖRÜNÜM (docs/08 → agent organizasyon şeması).
//
// Düğümler agent'lardır; oklar gerçek ilişkilerden gelir. Düğüm konumları
// hiyerarşiden türetilir: PM üstte, grup liderleri ortada, üyeler altta.
// Klonlar kaynaklarının yanında ve yarı saydam çizilir (T4).
import React from "react";
import { agentRoleLabel, agentStatusLabel } from "../services/labels.js";
import { Background, Controls, MiniMap, ReactFlow, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCanvasViewModel, type RoleFilter } from "../viewmodels/useCanvasViewModel.js";
import type { CanvasNode } from "../services/canvas.js";

// B2 — Takılma uyarı rengi: tek yerden alınır.
const STUCK_COLOR = "#f59e0b";

const STATUS_COLOR: Record<string, string> = {
  idle: "#199e70",
  busy: "#3987e5",
  waiting_verify: "#c98500",
  waiting_answer: "#c98500",
  escalated: "#d95926",
  stopped: "#6b7280",
};

// B3 — Ok türü renk ve kalınlıkları
const EDGE_STYLE: Record<string, { stroke: string; strokeWidth: number }> = {
  hierarchy: { stroke: "#6b7280", strokeWidth: 1.5 },
  assignment: { stroke: "#6ce9c5", strokeWidth: 2.5 },
  verification: { stroke: "#f0b429", strokeWidth: 2.5 },
  clone: { stroke: "#9b8afb", strokeWidth: 1.5 },
};

/** Geçen süreyi okunabilir kısa metne çevirir (ör. "3 dk 12 sn"). */
function formatElapsed(sec: number | undefined): string {
  if (sec === undefined) return "";
  if (sec < 60) return `${sec} sn`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m} dk ${s} sn`;
}

/** Model referansından kısa model adı çıkar (ör. "ollama:qwen3.6:latest" → "qwen3.6"). */
function shortModel(modelRef: string | undefined): string {
  if (!modelRef) return "?"; const parts = modelRef.split(":");
  // ollama:NAME:tag veya provider:NAME → NAME
  if (parts.length >= 2) return parts[1] ?? modelRef.slice(0, 20);
  return modelRef.slice(0, 20);
}

/**
 * Hiyerarşik düğüm yerleşimi (T4):
 * - Seviye 0 (Y: 40): PM
 * - Seviye 1 (Y: 200): Grup liderleri / Konsey
 * - Seviye 2 (Y: 360): İşçi, Denetçi, Araştırmacı vb.
 * - Klonlar: Kaynak düğümün yanında (+60px X, +35px Y) ve yarı saydam.
 */
export function computeHierarchicalPositions(
  nodes: readonly CanvasNode[]
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  const nonClones = nodes.filter((n) => !n.cloneOf);
  const clones = nodes.filter((n) => Boolean(n.cloneOf));

  const level0: CanvasNode[] = [];
  const level1: CanvasNode[] = [];
  const level2: CanvasNode[] = [];

  for (const node of nonClones) {
    if (node.role === "pm") {
      level0.push(node);
    } else if (node.role === "group_lead" || node.role === "council_member" || node.role === "interviewer") {
      level1.push(node);
    } else {
      level2.push(node);
    }
  }

  const placeLevel = (list: CanvasNode[], y: number) => {
    const spacing = 280;
    const totalWidth = (list.length - 1) * spacing;
    const startX = 400 - totalWidth / 2;
    list.forEach((node, idx) => {
      positions.set(node.id, { x: Math.max(40, startX + idx * spacing), y });
    });
  };

  placeLevel(level0, 40);
  placeLevel(level1, 200);
  placeLevel(level2, 360);

  // Klonları kaynaklarının yanına yerleştir
  for (const clone of clones) {
    const parentPos = clone.cloneOf ? positions.get(clone.cloneOf) : undefined;
    if (parentPos) {
      positions.set(clone.id, { x: parentPos.x + 60, y: parentPos.y + 35 });
    } else {
      positions.set(clone.id, { x: 400, y: 360 });
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
  if (error !== "") {
    return (
      <div className="canvas__empty-state canvas__empty-state--error" role="alert">
        <span className="canvas__empty-icon">⚠️</span>
        <p className="canvas__empty-title">Tuval verisi alınamadı</p>
        <p className="canvas__empty-desc">{error}</p>
      </div>
    );
  }

  if (rawData.nodes.length === 0) {
    return (
      <div className="canvas__empty-state" aria-live="polite">
        <span className="canvas__empty-icon">🤖</span>
        <p className="canvas__empty-title">Bu projede henüz agent çalışmıyor</p>
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

    // B1 — Zengin düğüm etiketi: ad + rol + görev + süre + model
    const elapsedStr = formatElapsed(node.elapsedSec);
    const modelShort = shortModel(node.modelRef);
    const taskLine = node.currentTaskTitle ? `📋 ${node.currentTaskTitle.slice(0, 35)}` : "";
    const elapsedLine = elapsedStr ? `⏱ ${elapsedStr}` : "";
    const stuckLine = node.stuckReason ? `⚠️ ${node.stuckReason}` : "";

    const labelParts = [
      `${node.label}`,
      `${agentRoleLabel(node.role)} · ${agentStatusLabel(node.status)}`,
      taskLine,
      elapsedLine,
      stuckLine,
      `🤖 ${modelShort}`,
    ].filter(Boolean);

    // B2 — Renk: takılıysa uyarı rengi, yoksa normal durum rengi
    const borderColor = isStuck
      ? STUCK_COLOR
      : (node.unresponsive ? "#d95926" : STATUS_COLOR[node.status] ?? "#6b7280");
    const borderStyle = (node.unresponsive || isStuck) ? "dashed" : "solid";

    return {
      id: node.id,
      position: pos,
      data: { label: labelParts.join("\n") },
      style: {
        background: isSelected ? "#1a3a5c" : "#17243a",
        border: `${isSelected ? "2.5" : "2"}px ${borderStyle} ${borderColor}`,
        borderRadius: 12,
        color: isDimmed ? "#4a5568" : "#fff",
        padding: 12,
        whiteSpace: "pre-line" as const,
        // B4 — Vurgulanmamış düğümler soluklaşır
        opacity: isDimmed ? 0.35 : (node.cloneOf === undefined ? 1 : 0.75),
        fontSize: 12,
        // B1 — Meşgul düğümde nabız animasyonu (CSS class ile)
        boxShadow: isBusy && !isDimmed ? `0 0 10px 2px ${borderColor}44` : undefined,
        transition: "opacity 0.2s, box-shadow 0.2s, border-color 0.2s",
      },
      // B1 — Meşgul düğüme pulse class ekle (CSS animasyon)
      className: isBusy && !isDimmed ? "canvas-node--pulse" : undefined,
    };
  });

  const edges = data.edges.map((edge) => {
    const style = EDGE_STYLE[edge.kind] ?? { stroke: "#6b7280", strokeWidth: 1.5 };
    const isDimmed = highlightSet !== undefined
      && !highlightSet.has(edge.source) && !highlightSet.has(edge.target);
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      animated: edge.animated,
      // B3 — Ok üzerinde görev başlığı (varsa); uzunsa kıs
      label: edge.taskTitle ? edge.taskTitle.slice(0, 32) : edge.label,
      // B3 — Tırmandırma oku kalın ve farklı renk
      style: {
        stroke: isDimmed ? "#2a3a50" : style.stroke,
        strokeWidth: isDimmed ? 1 : style.strokeWidth,
        transition: "stroke 0.2s, stroke-width 0.2s",
      },
      labelStyle: { fill: isDimmed ? "#2a3a50" : "#9fb3c8", fontSize: 11 },
      // B3 — Tırmandırma markeri farklı
      markerEnd: edge.kind === "verification"
        ? { type: "arrowclosed" as never, color: style.stroke, width: 20, height: 20 }
        : undefined,
    };
  });

  return (
    <div className="flow-canvas-wrapper">
      <RoleFilterBar value={roleFilter} onChange={setRoleFilter} />
      <div className="flow-canvas" onClick={(e) => { if ((e.target as HTMLElement).closest(".react-flow__node") === null) clearSelection(); }}>
        <ReactFlow
          nodes={nodes as never}
          edges={edges as never}
          fitView
          onNodeClick={(_event, node) => {
            setSelectedNodeId((prev) => prev === node.id ? undefined : node.id);
            onSelectAgent?.(node.id);
          }}
        >
          <Background color="#24344d" />
          <Controls />
          <MiniMap />
        </ReactFlow>
      </div>
    </div>
  );
}
