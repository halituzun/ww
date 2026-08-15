import { Background, Controls, MiniMap, ReactFlow, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';

type Task = { task_id: string; title: string; status: string; target_files?: string[] };

export function TaskCanvas({ tasks }: { readonly tasks: readonly Task[] }) {
  const nodes: Node[] = tasks.map((task, index) => ({ id: task.task_id, position: { x: (index % 3) * 240, y: Math.floor(index / 3) * 140 }, data: { label: `${task.title}\n${task.status}` }, style: { background: '#17243a', border: '1px solid #6ce9c5', borderRadius: 12, color: '#fff', padding: 12, whiteSpace: 'pre-line' } }));
  const edges: Edge[] = tasks.slice(1).map((task, index) => ({ id: `${tasks[index]!.task_id}->${task.task_id}`, source: tasks[index]!.task_id, target: task.task_id, animated: task.status === 'working', style: { stroke: '#6ce9c5' } }));
  return <div className="flow-canvas"><ReactFlow nodes={nodes} edges={edges} fitView><Background color="#24344d" /><Controls /><MiniMap /></ReactFlow></div>;
}
