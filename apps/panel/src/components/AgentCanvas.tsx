import React, { useState, useMemo } from "react";
import { CanvasContainer } from "./CanvasContainer.js";
import { DeptFrameNode } from "./DeptFrameNode.js";
import { useCanvasViewModel, type RoleFilter } from "../viewmodels/useCanvasViewModel.js";
import { computeOrgLayout, cleanRoleTitle } from "../viewmodels/canvas-layout.js";
import type { CanvasNode } from "../viewmodels/canvas-edges.js";
import { agentStatusLabel, formatElapsed } from "../services/labels.js";
import type { OrgPlan } from "@ww/shared";

const STATUS_COLOR: Readonly<Record<string, string>> = Object.freeze({
  idle: "#64748b",
  busy: "#38bdf8",
  waiting_verify: "#f59e0b",
  waiting_answer: "#a855f7",
  stopped: "#ef4444",
});

const STUCK_COLOR = "#f59e0b";

const EDGE_STYLE: Readonly<Record<string, { stroke: string; strokeWidth: number; strokeDasharray?: string }>> = Object.freeze({
  hierarchy: { stroke: "#38bdf8", strokeWidth: 1.6 },
  delegates: { stroke: "#10b981", strokeWidth: 1.6 },
  audit: { stroke: "#f59e0b", strokeWidth: 1.8, strokeDasharray: "4,4" },
  cross_dept: { stroke: "rgba(148, 163, 184, 0.7)", strokeWidth: 1.4, strokeDasharray: "5,5" },
  clone: { stroke: "#64748b", strokeWidth: 1 },
});

function cleanModelName(modelRef?: string): string {
  if (!modelRef || modelRef === "mock:pm" || modelRef === "mock:worker" || modelRef === "mock:verifier") {
    return "qwen3.6";
  }
  const parts = modelRef.split(":");
  return parts.length >= 2 ? parts[1]! : modelRef;
}

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

const nodeTypes = {
  deptFrame: DeptFrameNode,
};

export function AgentCanvas({
  projectId,
  orgPlan,
  onSelectAgent,
}: {
  readonly projectId: string;
  readonly orgPlan?: OrgPlan | undefined;
  readonly onSelectAgent?: ((agentId: string) => void) | undefined;
}) {
  const {
    data, rawData, error,
    roleFilter, setRoleFilter,
    selectedNodeId, setSelectedNodeId, clearSelection,
    highlightSet,
  } = useCanvasViewModel(projectId);

  const [collapsedDepts, setCollapsedDepts] = useState<Set<string>>(new Set());

  const handleToggleCollapse = (deptId: string) => {
    setCollapsedDepts((prev) => {
      const next = new Set(prev);
      if (next.has(deptId)) {
        next.delete(deptId);
        next.add(`open-${deptId}`);
      } else {
        next.add(deptId);
        next.delete(`open-${deptId}`);
      }
      return next;
    });
  };

  // E1 & E2: Deterministik organizasyon yerleşimi ve kenarlar
  const layout = useMemo(
    () => computeOrgLayout(data.nodes as readonly CanvasNode[], orgPlan, collapsedDepts),
    [data.nodes, orgPlan, collapsedDepts]
  );

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

  // 1. Departman Çerçeve Düğümleri
  const frameNodes = layout.groupNodes.map((frame) => ({
    id: frame.id,
    type: "deptFrame",
    position: frame.position,
    data: {
      ...frame.data,
      onToggleCollapse: handleToggleCollapse,
    },
    style: frame.style,
    selectable: false,
    draggable: false,
  }));

  // 2. Agent Düğümleri (Liderler, Yapanlar, Denetleyenler, PM, Yan Roller)
  const agentNodes = layout.augmentedNodes.map((node) => {
    const pos = layout.nodePositions.get(node.id) ?? { x: 100, y: 100 };
    const isSelected = selectedNodeId === node.id;
    const isDimmed = highlightSet !== undefined && !highlightSet.has(node.id);
    const isStuck = Boolean(node.stuckReason);
    const isBusy = node.status === "busy" || node.status === "waiting_verify" || node.status === "waiting_answer";

    const roleText = cleanRoleTitle(node.role);
    const statusText = agentStatusLabel(node.status);
    const elapsedText = formatElapsed(node.elapsedSec);
    const modelText = cleanModelName(node.modelRef);

    const line1 = node.label;
    const line2 = `${roleText} · ${statusText}${elapsedText ? ` · ${elapsedText}` : ""}${node.unresponsive ? " · yanıt vermiyor" : ""}`;
    const line3 = node.currentTaskTitle ? `Görev: ${node.currentTaskTitle.slice(0, 28)}` : "";
    const line4 = `Model: ${modelText}`;
    const line5 = node.stuckReason ? `Takılı: ${node.stuckReason}` : "";

    const labelParts = [line1, line2, line3, line4, line5].filter(Boolean);

    const borderColor = isStuck
      ? STUCK_COLOR
      : (node.unresponsive ? "#ef4444" : STATUS_COLOR[node.status] ?? "#64748b");
    const borderStyle = (node.unresponsive || isStuck) ? "dashed" : "solid";

    const isLead = node.role === "group_lead";

    return {
      id: node.id,
      position: { x: pos.x, y: pos.y },
      data: { label: labelParts.join(String.fromCharCode(10)) },
      style: {
        background: isSelected ? "#1e293b" : (isLead ? "#1e293b" : "#0f172a"),
        border: `${isSelected ? "2.5" : "2"}px ${borderStyle} ${isLead ? "#06b6d4" : borderColor}`,
        borderRadius: 8,
        color: isDimmed ? "#475569" : "#f1f5f9",
        padding: "8px 10px",
        whiteSpace: "pre-line",
        opacity: isDimmed ? 0.35 : (node.cloneOf === undefined ? 1 : 0.75),
        fontSize: 11,
        lineHeight: 1.4,
        minWidth: isLead ? 180 : 150,
        maxWidth: 200,
        boxShadow: isBusy && !isDimmed ? `0 0 12px 2px ${borderColor}33` : "0 4px 10px rgba(0,0,0,0.3)",
        transition: "opacity 0.2s, box-shadow 0.2s, border-color 0.2s",
        zIndex: 10,
      },
      className: isBusy && !isDimmed ? "canvas-node--pulse" : undefined,
    };
  });

  const allNodes = [...frameNodes, ...agentNodes];

  // 3. Kenarlar
  const activeEdges = layout.edges.length > 0 ? layout.edges : data.edges;
  const edges = activeEdges.map((edge) => {
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
        strokeDasharray: style.strokeDasharray,
        transition: "stroke 0.2s, stroke-width 0.2s",
      },
      labelStyle: {
        fill: isDimmed ? "#334155" : (edge.kind === "audit" ? "#f59e0b" : "#e2e8f0"),
        fontSize: 10,
        fontWeight: 500,
      },
      labelBgStyle: {
        fill: "#0b111c",
        fillOpacity: 0.95,
        rx: 4,
        ry: 4,
        stroke: edge.kind === "audit" ? "rgba(245, 158, 11, 0.3)" : "rgba(255, 255, 255, 0.14)",
        strokeWidth: 1,
      },
      labelBgPadding: [4, 2] as [number, number],
      markerEnd: {
        type: "arrowclosed" as never,
        color: isDimmed ? "#1e293b" : style.stroke,
        width: edge.kind === "hierarchy" ? 10 : 14,
        height: edge.kind === "hierarchy" ? 10 : 14,
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
        <CanvasContainer
          nodes={allNodes as never}
          edges={edges as never}
          nodeTypes={nodeTypes as never}
          fitViewOptions={{ padding: 0.15, minZoom: 0.6, maxZoom: 1.2 }}
          onNodeClick={(_event, node) => {
            if (node.type === "deptFrame") return;
            setSelectedNodeId((prev) => (prev === node.id ? undefined : node.id));
            onSelectAgent?.(node.id);
          }}
        />
      </div>
    </div>
  );
}
