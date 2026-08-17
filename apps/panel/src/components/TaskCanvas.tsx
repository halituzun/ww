// Canlı tuval (docs/08). Oklar GERÇEK ilişkilerden gelir: bağımlılık ve
// delegasyon. Ardışık görevleri bağlamak uydurma bir grafik üretiyordu.
import { Background, Controls, MiniMap, ReactFlow, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { taskCanvasEdges, type CanvasTask } from '../viewmodels/canvas-edges.js';

type Task = CanvasTask & { title: string; target_files?: string[] };

export function TaskCanvas({ tasks, statusByTask }: {
  readonly tasks: readonly Task[];
  /**
   * Geçmişe kaydırıldığında o andaki durumlar (docs/11 Faz 5). Verilmezse
   * canlı durum çizilir. Olayı olmayan görev "bilinmiyor" yazılır: şimdiki
   * durumu geçmişe yazmak olmayan bir geçmiş uydurmak olurdu.
   */
  readonly statusByTask?: ReadonlyMap<string, string> | undefined;
}) {
  const statusOf = (task: Task): string =>
    statusByTask === undefined ? task.status : statusByTask.get(task.task_id) ?? 'bilinmiyor';

  const nodes: Node[] = tasks.map((task, index) => ({
    id: task.task_id,
    position: { x: (index % 3) * 240, y: Math.floor(index / 3) * 140 },
    data: { label: `${task.title}\n${statusOf(task)}` },
    style: {
      background: '#17243a', border: '1px solid #6ce9c5', borderRadius: 12,
      color: '#fff', padding: 12, whiteSpace: 'pre-line',
    },
  }));

  // Bağımlılık ve delegasyon farklı şeylerdir; aynı görünmeleri okuyanı yanıltır.
  const edges: Edge[] = taskCanvasEdges(tasks).map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    animated: edge.animated,
    label: edge.kind === 'delegates' ? 'iş verdi' : 'bekliyor',
    style: { stroke: edge.kind === 'delegates' ? '#f0b429' : '#6ce9c5' },
    labelStyle: { fill: '#9fb3c8', fontSize: 11 },
  }));

  return (
    <div className="flow-canvas">
      <ReactFlow nodes={nodes} edges={edges} fitView>
        <Background color="#24344d" />
        <Controls />
        <MiniMap />
      </ReactFlow>
    </div>
  );
}
