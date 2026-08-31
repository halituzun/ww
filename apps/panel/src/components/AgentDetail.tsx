function cleanModelName(modelRef: string | undefined): string {
  if (!modelRef || modelRef === '' || modelRef === 'unknown') return 'model bilinmiyor';
  const parts = modelRef.split(':');
  if (parts.length >= 2) {
    const name = parts[1] ?? parts[0] ?? 'model bilinmiyor';
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

  if (!agentId) {
    return <p className="hint" style={{ padding: "16px", color: "#64748b", fontSize: "12px" }}>Geçmişi görmek için tuvalden bir agent seçin.</p>;
  }
  if (error !== '') return <p className="canvas__error" style={{ padding: "16px", color: "#f87171" }}>{error}</p>;
  if (detail === undefined) {
    return (
      <div style={{ padding: "16px", color: "#94a3b8", fontSize: "12px", display: "flex", alignItems: "center", gap: "8px" }}>
        <span className="dot dot-waiting" style={{ animation: "pulse 1.5s infinite" }} /> Agent geçmişi yükleniyor…
      </div>
    );
  }

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

      <div style={{ marginTop: '16px', borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: '12px' }}>
        <h5 style={{ fontSize: '12px', color: '#94a3b8', marginBottom: '8px', fontWeight: 600 }}>Çift Yönlü Konuşma Geçmişi</h5>
        {!detail.conversations || detail.conversations.length === 0 ? (
          <p className="hint" style={{ fontSize: '11px' }}>Bu agent için henüz kayıtlı mesajlaşma yok.</p>
        ) : (
          <div className="agent-conversations-list" style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {detail.conversations.map((msg) => (
              <div
                key={msg.id}
                style={{
                  padding: '6px 8px',
                  borderRadius: '6px',
                  background: msg.direction === 'outgoing' ? 'rgba(56, 189, 248, 0.1)' : 'rgba(15, 23, 42, 0.6)',
                  borderLeft: `3px solid ${msg.direction === 'outgoing' ? '#38bdf8' : '#10b981'}`,
                  fontSize: '11px',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', color: '#64748b', fontSize: '10px', marginBottom: '2px' }}>
                  <span>{msg.direction === 'outgoing' ? '→ Gönderildi:' : '← Alındı:'} <strong style={{ color: '#cbd5e1' }}>{msg.counterpart}</strong></span>
                </div>
                <div style={{ color: '#e2e8f0', lineHeight: 1.35 }}>{msg.summary}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
