// Canlı tuvalin veri izdüşümü (docs/08 → "Canlı Tuval").
//
// NEDEN VAR: docs/08 tuvali AGENT'ların organizasyon şeması olarak tanımlıyor
// ("düğümler: agent'lar; kenarlar: hiyerarşi + aktif iş ilişkisi") ve ilk yükü
// `GET /projects/:id/canvas` diye adlandırıyor. Ne bu uç vardı ne de tuval
// agent gösteriyordu: panel görevleri çiziyordu. Yani kullanıcının en baştan
// istediği "kim kime iş verdi" görüntüsü hiç kurulmamıştı.
//
// İzdüşüm UYDURMAZ: kenarlar yalnızca gerçek alanlardan (parent_agent_id,
// clone_of, task.issuer/worker/verifier) türer.

export interface CanvasAgentLike {
  readonly agent_id: string;
  readonly role: string;
  readonly group: string;
  readonly name: string;
  readonly model_ref: string;
  readonly parent_agent_id: string;
  readonly clone_of: string;
  readonly status: string;
  readonly current_task_id: string;
}

export interface CanvasTaskLike {
  readonly task_id: string;
  readonly title: string;
  readonly status: string;
  readonly issuer_agent_id: string;
  readonly worker_agent_id: string;
  readonly verifier_agent_id: string;
}

export interface CanvasNode {
  readonly id: string;
  readonly label: string;
  readonly role: string;
  readonly group: string;
  readonly modelRef: string;
  readonly status: string;
  /**
   * Agent MEŞGUL görünüyor ama canlılık işareti yok. Kaydedilmiş durum tek
   * başına yalan söyleyebilir: süreç ölünce satır 'busy' kalır ve tuval
   * çalışmayan bir agent'ı çalışıyor gösterir.
   */
  readonly unresponsive: boolean;
  readonly cloneOf: string | undefined;
  readonly currentTaskId: string | undefined;
}

export type CanvasEdgeKind = 'hierarchy' | 'assignment' | 'verification' | 'clone';

export interface CanvasEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly kind: CanvasEdgeKind;
  readonly label: string;
  /** Yalnızca AKTİF ilişki animasyonlu olur; biten iş hareketli görünmemeli. */
  readonly animated: boolean;
  readonly taskId: string | undefined;
}

export interface CanvasProjection {
  readonly nodes: readonly CanvasNode[];
  readonly edges: readonly CanvasEdge[];
}

const NIL = '00000000-0000-0000-0000-000000000000';

const concrete = (value: string | undefined): string | undefined =>
  value === undefined || value === '' || value === NIL ? undefined : value;

/** Bitmiş görev aktif iş ilişkisi DEĞİLDİR. */
const ACTIVE_TASK_STATUSES: ReadonlySet<string> = new Set([
  'queued', 'assigned', 'working', 'verifying', 'testing', 'committing',
  'waiting_user', 'escalated',
]);

/** Canlılık işareti olan agent'lar; verilmezse hiçbiri "yanıt vermiyor" sayılmaz. */
export type LiveAgentIds = ReadonlySet<string>;

/** Canlılık beklenen durumlar: bu durumlarda heartbeat YOKSA agent ölüdür. */
const LIVE_EXPECTED: ReadonlySet<string> = new Set([
  'busy', 'waiting_verify', 'waiting_answer',
]);

/**
 * Rol → model eşlemesi. Agent'ın KENDİ `model_ref`'i yalnızca eşleme yoksa
 * kullanılır — çağrılar da bu sırayla yönlendirilir.
 *
 * NEDEN VAR: tuval agent satırındaki modeli yazıyordu. Canlı projede o satır
 * `mock:worker` diyordu ama 16 gerçek çağrının hepsi `deepseek:deepseek-chat`
 * ile yapılmıştı: panel, agent'ın HİÇ KULLANMADIĞI bir modeli gösteriyordu.
 */
export type RoleModelResolver = (role: string) => string | undefined;

export function buildCanvasProjection(
  agents: readonly CanvasAgentLike[],
  tasks: readonly CanvasTaskLike[],
  liveAgentIds?: LiveAgentIds,
  modelForRole?: RoleModelResolver,
): CanvasProjection {
  const known = new Set(agents.map((agent) => agent.agent_id));
  const nodes: CanvasNode[] = agents.map((agent) => ({
    id: agent.agent_id,
    label: agent.name === '' ? agent.role : agent.name,
    role: agent.role,
    group: agent.group,
    modelRef: modelForRole?.(agent.role) ?? agent.model_ref,
    status: agent.status,
    // Bilgi yoksa suçlamayız: heartbeat kümesi verilmediğinde kimse
    // "yanıt vermiyor" işaretlenmez.
    unresponsive: liveAgentIds !== undefined
      && LIVE_EXPECTED.has(agent.status)
      && !liveAgentIds.has(agent.agent_id),
    cloneOf: concrete(agent.clone_of),
    currentTaskId: concrete(agent.current_task_id),
  }));

  const edges: CanvasEdge[] = [];
  const push = (edge: CanvasEdge): void => {
    // Bilinmeyen düğüme giden kenar tuvalde kopuk ok çizer.
    if (!known.has(edge.source) || !known.has(edge.target)) return;
    if (edge.source === edge.target) return;
    if (edges.some((existing) => existing.id === edge.id)) return;
    edges.push(edge);
  };

  for (const agent of agents) {
    const parent = concrete(agent.parent_agent_id);
    if (parent !== undefined) {
      push({
        id: `hierarchy:${parent}:${agent.agent_id}`,
        source: parent, target: agent.agent_id, kind: 'hierarchy',
        label: 'hiyerarşi', animated: false, taskId: undefined,
      });
    }
    const cloneOf = concrete(agent.clone_of);
    if (cloneOf !== undefined) {
      push({
        id: `clone:${cloneOf}:${agent.agent_id}`,
        source: cloneOf, target: agent.agent_id, kind: 'clone',
        label: 'klon', animated: false, taskId: undefined,
      });
    }
  }

  for (const task of tasks) {
    const active = ACTIVE_TASK_STATUSES.has(task.status);
    const issuer = concrete(task.issuer_agent_id);
    const worker = concrete(task.worker_agent_id);
    const verifier = concrete(task.verifier_agent_id);

    if (issuer !== undefined && worker !== undefined) {
      push({
        id: `assignment:${task.task_id}`,
        source: issuer, target: worker, kind: 'assignment',
        label: 'iş verdi', animated: active, taskId: task.task_id,
      });
    }
    if (worker !== undefined && verifier !== undefined) {
      push({
        id: `verification:${task.task_id}`,
        source: worker, target: verifier, kind: 'verification',
        label: 'denetim', animated: active && task.status === 'verifying', taskId: task.task_id,
      });
    }
  }

  return Object.freeze({ nodes: Object.freeze(nodes), edges: Object.freeze(edges) });
}
