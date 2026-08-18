// Canlı tuval — SALT GÖRÜNÜM (docs/08 → agent organizasyon şeması).
//
// Düğümler agent'lardır; oklar gerçek ilişkilerden gelir. Durum YALNIZ renkle
// değil metinle de yazılır: renk tek başına anlam taşımaz.
import { agentRoleLabel, agentStatusLabel } from '../services/labels.js';
import { Background, Controls, MiniMap, ReactFlow, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCanvasViewModel } from '../viewmodels/useCanvasViewModel.js';

const STATUS_COLOR: Record<string, string> = {
  idle: '#199e70', busy: '#3987e5', waiting_verify: '#c98500',
  waiting_answer: '#c98500', escalated: '#d95926', stopped: '#6b7280',
};

const EDGE_COLOR: Record<string, string> = {
  hierarchy: '#6b7280', assignment: '#6ce9c5', verification: '#f0b429', clone: '#9b8afb',
};

export function AgentCanvas({ projectId, onSelectAgent }: {
  readonly projectId: string;
  /** docs/08: düğüme tık → agent geçmişi. */
  readonly onSelectAgent?: ((agentId: string) => void) | undefined;
}) {
  const { data, error } = useCanvasViewModel(projectId);

  if (error !== '') return <p className="canvas__error">{error}</p>;
  if (data.nodes.length === 0) return <p className="hint">Bu projede agent yok.</p>;

  const nodes: Node[] = data.nodes.map((node, index) => ({
    id: node.id,
    position: { x: (index % 3) * 260, y: Math.floor(index / 3) * 150 },
    // "yanıt vermiyor" METİNLE yazılır: kaydedilmiş durum tek başına yalan
    // söyleyebilir ve renk tek başına anlam taşımaz.
    data: {
      label: `${node.label}\n${agentRoleLabel(node.role)} · ${agentStatusLabel(node.status)}`
        + `${node.unresponsive === true ? ' · yanıt vermiyor' : ''}\n${node.modelRef}`,
    },
    style: {
      background: '#17243a',
      border: `2px ${node.unresponsive === true ? 'dashed' : 'solid'} `
        + `${node.unresponsive === true ? '#d95926' : STATUS_COLOR[node.status] ?? '#6b7280'}`,
      borderRadius: 12,
      color: '#fff',
      padding: 12,
      whiteSpace: 'pre-line',
      // Klon kaynağının yanında yarı saydam (docs/08).
      opacity: node.cloneOf === undefined ? 1 : 0.75,
      fontSize: 12,
    },
  }));

  const edges: Edge[] = data.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    animated: edge.animated,
    label: edge.label,
    style: { stroke: EDGE_COLOR[edge.kind] ?? '#6b7280' },
    labelStyle: { fill: '#9fb3c8', fontSize: 11 },
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
