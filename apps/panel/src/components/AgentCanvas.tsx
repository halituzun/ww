// Canlı tuval — SALT GÖRÜNÜM (docs/08 → agent organizasyon şeması).
//
// Düğümler agent'lardır; oklar gerçek ilişkilerden gelir. Düğüm konumları
// hiyerarşiden türetilir: PM üstte, grup liderleri ortada, üyeler altta.
// Klonlar kaynaklarının yanında ve yarı saydam çizilir (T4).
import { agentRoleLabel, agentStatusLabel } from "../services/labels.js";
import { Background, Controls, MiniMap, ReactFlow, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCanvasViewModel } from "../viewmodels/useCanvasViewModel.js";
import type { CanvasNode } from "../services/canvas.js";

const STATUS_COLOR: Record<string, string> = {
  idle: "#199e70",
  busy: "#3987e5",
  waiting_verify: "#c98500",
  waiting_answer: "#c98500",
  escalated: "#d95926",
  stopped: "#6b7280",
};

const EDGE_COLOR: Record<string, string> = {
  hierarchy: "#6b7280",
  assignment: "#6ce9c5",
  verification: "#f0b429",
  clone: "#9b8afb",
};

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

export function AgentCanvas({
  projectId,
  onSelectAgent,
}: {
  readonly projectId: string;
  /** docs/08: düğüme tık → agent geçmişi. */
  readonly onSelectAgent?: ((agentId: string) => void) | undefined;
}) {
  const { data, error } = useCanvasViewModel(projectId);

  if (error !== "") return <p className="canvas__error">{error}</p>;
  if (data.nodes.length === 0) return <p className="hint">Bu projede agent yok.</p>;

  const positions = computeHierarchicalPositions(data.nodes);

  const nodes: Node[] = data.nodes.map((node) => {
    const pos = positions.get(node.id) ?? { x: 100, y: 100 };
    return {
      id: node.id,
      position: pos,
      // "yanıt vermiyor" METİNLE yazılır: renk tek başına anlam taşımaz.
      data: {
        label:
          `${node.label}\n${agentRoleLabel(node.role)} · ${agentStatusLabel(node.status)}` +
          `${node.unresponsive === true ? " · yanıt vermiyor" : ""}\n${node.modelRef}`,
      },
      style: {
        background: "#17243a",
        border: `2px ${node.unresponsive === true ? "dashed" : "solid"} ` +
          `${node.unresponsive === true ? "#d95926" : STATUS_COLOR[node.status] ?? "#6b7280"}`,
        borderRadius: 12,
        color: "#fff",
        padding: 12,
        whiteSpace: "pre-line",
        // Klon kaynağının yanında yarı saydam (docs/08 T4).
        opacity: node.cloneOf === undefined ? 1 : 0.75,
        fontSize: 12,
      },
    };
  });

  const edges: Edge[] = data.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    animated: edge.animated,
    label: edge.label,
    style: { stroke: EDGE_COLOR[edge.kind] ?? "#6b7280" },
    labelStyle: { fill: "#9fb3c8", fontSize: 11 },
  }));

  return (
    <div className="flow-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        onNodeClick={(_event, node) => onSelectAgent?.(node.id)}
      >
        <Background color="#24344d" />
        <Controls />
        <MiniMap />
      </ReactFlow>
    </div>
  );
}
