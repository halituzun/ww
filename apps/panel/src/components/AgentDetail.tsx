function cleanModelName(modelRef: string | undefined): string {
  if (!modelRef || modelRef === '' || modelRef === 'unknown') return 'model bilinmiyor';
  const parts = modelRef.split(':');
  if (parts.length >= 2) {
    const name = parts[1] ?? parts[0];
    if (parts.length >= 3 && parts[2] !== 'latest') {
      return `${name}:${parts[2]}`;
    }
    return name;
  }
  return modelRef.slice(0, 24);
}
// Agent geçmişi yan paneli — SALT GÖRÜNÜM (docs/08 → "düğüme tık → yan
// panelde agent geçmişi: görevleri, mesajları, harcadığı token").
import { agentRoleLabel, agentStatusLabel } from '../services/labels.js';
import { taskStatusLabel } from '../services/task-status.js';
import {
  useAgentDetailViewModel, type AgentDetailViewModelPorts,
} from '../viewmodels/useAgentDetailViewModel.js';

const RELATION_LABEL: Record<string, string> = {
  issuer: 'iş verdi', worker: 'yaptı', verifier: 'denetledi',
};

export function AgentDetail({ projectId, agentId, ports }: {
  readonly projectId: string;
  readonly agentId: string | undefined;
  /** Testler gerçek uca gitmeden görünümü sürebilsin diye. */
  readonly ports?: AgentDetailViewModelPorts;
}) {
  const { detail, error } = useAgentDetailViewModel(projectId, agentId, ports);

  if (agentId === undefined) {
    return <p className="hint">Geçmişi görmek için tuvalden bir agent seçin.</p>;
  }
  if (error !== '') return <p className="canvas__error">{error}</p>;
  if (detail === undefined) return <p className="hint">Yükleniyor…</p>;

  return (
    <section className="agent-detail" aria-label="Agent geçmişi">
      <div className="section-heading">
        <h4>{detail.name}</h4>
        <small>{agentRoleLabel(detail.role)} · {agentStatusLabel(detail.status)} · {cleanModelName(detail.modelRef)}</small>
      </div>

      <dl className="fihrist__meta">
        <dt>Görev</dt><dd>{detail.tasks.length}</dd>
        <dt>Tamamladı</dt><dd>{detail.tasksDone}</dd>
        <dt>Reddedildi</dt><dd>{detail.tasksRejected}</dd>
        <dt>Mesaj</dt><dd>{detail.messageCount}</dd>
        <dt>Çağrı</dt><dd>{detail.calls}</dd>
        <dt>Token</dt><dd>{detail.promptTokens + detail.completionTokens}</dd>
        <dt>Maliyet</dt><dd>${detail.costUsd.toFixed(4)}</dd>
      </dl>

      {detail.tasks.length === 0 ? (
        <p className="hint">Bu agent henüz hiçbir göreve bağlanmadı.</p>
      ) : (
        <ul className="agent-detail__tasks">
          {detail.tasks.map((task) => (
            <li key={`${task.taskId}:${task.relation}`}>
              <span className="pill">{RELATION_LABEL[task.relation] ?? task.relation}</span>
              <strong>{task.title}</strong>
              <span className={`pill pill--${task.status}`}>{taskStatusLabel(task.status)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
