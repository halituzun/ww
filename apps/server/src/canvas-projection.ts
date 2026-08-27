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
  /** ISO zaman damgası — durum değiştikten bu yana geçen süreyi hesaplar. */
  readonly status_changed_at?: string;
}

export interface CanvasTaskLike {
  readonly task_id: string;
  readonly title: string;
  readonly status: string;
  readonly issuer_agent_id: string;
  readonly worker_agent_id: string;
  readonly verifier_agent_id: string;
}

/** Takılan agent eşiği (saniye). Tek yerden değiştirilir, uydurma sabit yayılmaz. */
export const STUCK_THRESHOLD_SEC = 300; // 5 dakika

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
  /** Şu anki görevin başlığı (varsa); ID değil. */
  readonly currentTaskTitle: string | undefined;
  /** Bu durumda kaç saniyedir bekleniyor (undefined = bilgi yok). */
  readonly elapsedSec: number | undefined;
  /**
   * Takılı agent için gösterilecek neden metni. Tanımlıysa düğüm uyarı
   * rengine (#f59e0b) geçer ve bu metin düğümde görünür.
   */
  readonly stuckReason: string | undefined;
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
  /** Göreve ait başlık; ok üzerinde hover tooltip için. */
  readonly taskTitle: string | undefined;
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

/** Durum değişiminden bu yana geçen saniyeyi hesaplar; bilgi yoksa undefined. */
const elapsedSecOf = (changedAt: string | undefined, nowMs: number): number | undefined => {
  if (!changedAt) return undefined;
  const ms = nowMs - new Date(changedAt).getTime();
  return ms >= 0 ? Math.floor(ms / 1000) : undefined;
};

/** Takılan agent için neden döndür; takılı değilse undefined. */
const stuckReasonOf = (
  status: string,
  elapsedSec: number | undefined,
): string | undefined => {
  if (elapsedSec === undefined || elapsedSec < STUCK_THRESHOLD_SEC) return undefined;
  if (status === 'waiting_answer') return 'cevap bekliyor';
  if (status === 'waiting_verify') return 'doğrulama bekliyor';
  if (status === 'busy') return 'yanıt vermiyor';
  return undefined;
};

export function buildCanvasProjection(
  agents: readonly CanvasAgentLike[],
  tasks: readonly CanvasTaskLike[],
  liveAgentIds?: LiveAgentIds,
  modelForRole?: RoleModelResolver,
  nowMs: number = Date.now(),
): CanvasProjection {
  const known = new Set(agents.map((agent) => agent.agent_id));
  // Görev ID → başlık haritası (düğümde görev başlığı göstermek için)
  const taskTitleMap = new Map(tasks.map((t) => [t.task_id, t.title]));

  const nodes: CanvasNode[] = agents.map((agent) => {
    const elapsed = elapsedSecOf(agent.status_changed_at, nowMs);
    const isUnresponsive = liveAgentIds !== undefined
      && LIVE_EXPECTED.has(agent.status)
      && !liveAgentIds.has(agent.agent_id);
    const taskId = concrete(agent.current_task_id);
    return {
      id: agent.agent_id,
      label: agent.name === '' ? agent.role : agent.name,
      role: agent.role,
      group: agent.group,
      modelRef: modelForRole?.(agent.role) ?? agent.model_ref,
      status: agent.status,
      // Bilgi yoksa suçlamayız: heartbeat kümesi verilmediğinde kimse
      // "yanıt vermiyor" işaretlenmez.
      unresponsive: isUnresponsive,
      cloneOf: concrete(agent.clone_of),
      currentTaskId: taskId,
      currentTaskTitle: taskId !== undefined ? taskTitleMap.get(taskId) : undefined,
      elapsedSec: elapsed,
      stuckReason: isUnresponsive ? 'yanıt vermiyor' : stuckReasonOf(agent.status, elapsed),
    };
  });

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
        label: 'hiyerarşi', animated: false, taskId: undefined, taskTitle: undefined,
      });
    }
    const cloneOf = concrete(agent.clone_of);
    if (cloneOf !== undefined) {
      push({
        id: `clone:${cloneOf}:${agent.agent_id}`,
        source: cloneOf, target: agent.agent_id, kind: 'clone',
        label: 'klon', animated: false, taskId: undefined, taskTitle: undefined,
      });
    }
  }

  // Görev oklarını kaynak-hedef çiftine göre grupla: üst üste binen etiketleri önler
  const assignmentGroups = new Map<string, { issuer: string; worker: string; tasks: CanvasTaskLike[] }>();
  const verificationGroups = new Map<string, { worker: string; verifier: string; tasks: CanvasTaskLike[] }>();

  for (const task of tasks) {
    const issuer = concrete(task.issuer_agent_id);
    const worker = concrete(task.worker_agent_id);
    const verifier = concrete(task.verifier_agent_id);

    if (issuer !== undefined && worker !== undefined) {
      const key = `${issuer}->${worker}`;
      const group = assignmentGroups.get(key) ?? { issuer, worker, tasks: [] };
      group.tasks.push(task);
      assignmentGroups.set(key, group);
    }
    if (worker !== undefined && verifier !== undefined) {
      const key = `${worker}->${verifier}`;
      const group = verificationGroups.get(key) ?? { worker, verifier, tasks: [] };
      group.tasks.push(task);
      verificationGroups.set(key, group);
    }
  }

  for (const [, group] of assignmentGroups) {
    const hasActive = group.tasks.some((t) => ACTIVE_TASK_STATUSES.has(t.status));
    const activeTasks = group.tasks.filter((t) => ACTIVE_TASK_STATUSES.has(t.status));
    const representative = activeTasks[0] ?? group.tasks[0];
    const count = group.tasks.length;
    const label = count > 1 ? `${count} görev` : (representative?.title ? representative.title.slice(0, 35) : 'iş verdi');
    const allTitles = group.tasks.map((t) => t.title).filter(Boolean).join(' · ');

    push({
      id: `assignment:${group.issuer}:${group.worker}`,
      source: group.issuer,
      target: group.worker,
      kind: 'assignment',
      label,
      animated: hasActive,
      taskId: representative?.task_id,
      taskTitle: allTitles || label,
    });
  }

  for (const [, group] of verificationGroups) {
    const isVerifying = group.tasks.some((t) => t.status === 'verifying');
    const representative = group.tasks[0];
    const count = group.tasks.length;
    const label = count > 1 ? `${count} denetim` : 'denetim';
    const allTitles = group.tasks.map((t) => t.title).filter(Boolean).join(' · ');

    push({
      id: `verification:${group.worker}:${group.verifier}`,
      source: group.worker,
      target: group.verifier,
      kind: 'verification',
      label,
      animated: isVerifying,
      taskId: representative?.task_id,
      taskTitle: allTitles || label,
    });
  }

  return Object.freeze({ nodes: Object.freeze(nodes), edges: Object.freeze(edges) });
}
