// Canlı tuval (docs/08). Oklar GERÇEK ilişkilerden gelir: bağımlılık ve
// delegasyon. Ardışık görevleri bağlamak uydurma bir grafik üretiyordu.
import React from 'react';
import { Background, Controls, ReactFlow, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { taskCanvasEdges, type CanvasTask } from '../viewmodels/canvas-edges.js';
import { taskStatusLabel } from '../services/labels.js';

type Task = CanvasTask & { title: string; target_files?: string[] };

export function TaskCanvas({ tasks, statusByTask }: {
  readonly tasks: readonly Task[];
  /**
   * Geçmişe kaydırıldığında o andaki durumlar (docs/11 Faz 5). Verilmezse
   * canlı durum çizilir. Olayı olmayan görev "bilinmiyor" yazılmaz;
   * varsa geçmiş durum, yoksa görevin mevcut durumu Türkçe etiketiyle basılır.
   */
  readonly statusByTask?: ReadonlyMap<string, string> | undefined;
}) {
  const statusOf = (task: Task): string => {
    if (statusByTask === undefined) {
      return taskStatusLabel(task.status);
    }
    // Geçmiş zaman çizelgesi modu: o andaki geçmiş durumu bas, yoksa bilinmiyor
    const pastStatus = statusByTask.get(task.task_id);
    return pastStatus ? taskStatusLabel(pastStatus) : 'bilinmiyor';
  };

  const nodes: Node[] = tasks.map((task, index) => ({
    id: task.task_id,
    position: { x: (index % 3) * 260 + 40, y: Math.floor(index / 3) * 140 + 40 },
    data: { label: `${task.title}\n${statusOf(task)}` },
    style: {
      background: '#0f172a',
      border: '2px solid #38bdf8',
      borderRadius: 10,
      color: '#f1f5f9',
      padding: '10px 14px',
      whiteSpace: 'pre-line',
      fontSize: 12,
      lineHeight: 1.45,
      minWidth: 220,
      boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
    },
  }));

  // Bağımlılık ve delegasyon farklı şeylerdir; aynı görünmeleri okuyanı yanıltır.
  const edges: Edge[] = taskCanvasEdges(tasks).map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    animated: edge.animated,
    type: 'smoothstep',
    label: edge.kind === 'delegates' ? 'iş verdi' : 'bekliyor',
    style: { stroke: edge.kind === 'delegates' ? '#f0b429' : '#38bdf8', strokeWidth: 1.5 },
    labelStyle: { fill: '#94a3b8', fontSize: 11, fontWeight: 500 },
    labelBgStyle: {
      fill: '#0b111c',
      fillOpacity: 0.95,
      rx: 4,
      ry: 4,
      stroke: 'rgba(255, 255, 255, 0.14)',
      strokeWidth: 1,
    },
    labelBgPadding: [6, 4] as [number, number],
  }));

  // Boş durum AÇIKÇA söylenir (docs/09 ui_audit). Boş bir TUVAL, hata mı yok
  // mu belli olmayan bir beyaz alandır: kullanıcı "yükleniyor mu?" diye
  // bakakalır. Metin, sessiz boşluktan her zaman iyidir.
  if (tasks.length === 0) {
    return <p className="hint">Bu projede henüz görev yok — tuvalde çizilecek bir şey yok.</p>;
  }

  return (
    <div className="flow-canvas" style={{ width: '100%', height: '100%', minHeight: 480 }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#1e293b" gap={16} />
        <Controls position="bottom-right" showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
