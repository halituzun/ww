// Tuval oklarının GERÇEK ilişkilerden türetilmesi (docs/08 → canlı tuval).
//
// NEDEN VAR: tuval, dizideki ARDIŞIK görevleri birbirine bağlıyordu. Bu
// uydurma bir bağımlılık grafiğidir: kullanıcı "A, B'yi bekliyor" diye okur
// ama böyle bir ilişki yoktur. Yanlış bilgi gösteren bir panel, hiç
// göstermeyenden kötüdür — özellikle amacı sistemi ANLAMAK olan bir ekranda.
//
// Gerçek kaynaklar: `depends_on` (bağımlılık) ve `parent_task_id`
// (delegasyon — docs/08'in "kim kime iş verdi" sorusu).
export interface CanvasTask {
  readonly task_id: string;
  readonly status: string;
  readonly depends_on?: readonly string[];
  readonly parent_task_id?: string;
}

export type CanvasEdgeKind = 'depends' | 'delegates' | 'hierarchy' | 'clone' | 'audit' | 'cross_dept';

export interface CanvasEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly kind: CanvasEdgeKind;
  readonly animated?: boolean;
  readonly label?: string;
}

export interface CanvasNode {
  readonly id: string;
  readonly label: string;
  readonly role: string;
  readonly status: string;
  readonly currentTaskId?: string;
  readonly currentTaskTitle?: string;
  readonly modelRef: string;
  readonly elapsedSec: number;
  readonly stuckReason?: string;
  readonly cloneOf?: string;
  readonly unresponsive?: boolean;
  readonly departmentId?: string;
}

const NIL = '00000000-0000-0000-0000-000000000000';

export function taskCanvasEdges(tasks: readonly CanvasTask[]): readonly CanvasEdge[] {
  const known = new Set(tasks.map((task) => task.task_id));
  const edges: CanvasEdge[] = [];
  const seen = new Set<string>();

  const add = (source: string, target: string, kind: CanvasEdgeKind, animated: boolean) => {
    // Bilinmeyen göreve ok çizmek boşluğa işaret eder; grafik yalan söyler.
    if (!known.has(source) || !known.has(target) || source === target) return;
    const id = `${kind}:${source}->${target}`;
    if (seen.has(id)) return;
    seen.add(id);
    edges.push({ id, source, target, kind, animated });
  };

  for (const task of tasks) {
    const active = task.status === 'working' || task.status === 'verifying' || task.status === 'testing';
    if (task.parent_task_id !== undefined && task.parent_task_id !== NIL) {
      add(task.parent_task_id, task.task_id, 'delegates', active);
    }
    for (const dependency of task.depends_on ?? []) {
      if (dependency === NIL) continue;
      add(dependency, task.task_id, 'depends', active);
    }
  }
  return Object.freeze(edges);
}
