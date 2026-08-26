import React from "react";
import { taskStatusLabel, isTaskRunning, isTaskDone } from "../services/task-status.js";
import { agentRoleLabel } from "../services/labels.js";
import type { Task } from "../services/projects.js";
import type { AuditFinding } from "../services/audit.js";
import type { ChatMessage } from "../services/questions.js";
import type { Artifact } from "../services/files.js";

export function TaskDetailDrawer({
  task,
  onClose,
  findings = [],
  messages = [],
  artifacts = [],
  onSelectFile,
}: {
  readonly task: Task | undefined;
  readonly onClose: () => void;
  readonly findings?: readonly AuditFinding[];
  readonly messages?: readonly ChatMessage[];
  readonly artifacts?: readonly Artifact[];
  readonly onSelectFile?: (path: string) => void;
}) {
  if (!task) return null;

  const isRunning = isTaskRunning(task.status);
  const isDone = isTaskDone(task.status);
  const taskMessages = messages.filter((m) => m.taskId === task.task_id);
  const taskFindings = findings.filter((f) => f.task_id === task.task_id);
  const targetFiles = Array.isArray(task.target_files) ? task.target_files : [];
  const acceptanceCriteria = Array.isArray(task.acceptance_criteria) ? task.acceptance_criteria : [];

  return (
    <div className="drawer-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="Görev detayları">
      <aside className="drawer-panel" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-header">
          <div>
            <div className="drawer-badges">
              <span className={`pill ${isRunning ? "pill--running" : isDone ? "pill--done" : "pill--queued"}`}>
                {taskStatusLabel(task.status)}
              </span>
              <span className="pill pill--mini">Öncelik {task.priority ?? 5}</span>
              {task.group ? <span className="pill pill--mini">{task.group}</span> : null}
            </div>
            <h2 className="drawer-title">{task.title}</h2>
            <code className="drawer-id">ID: {task.task_id}</code>
          </div>
          <button type="button" className="btn-close" onClick={onClose} aria-label="Kapat">
            ✕
          </button>
        </div>

        <div className="drawer-body">
          {task.description ? (
            <section className="drawer-section">
              <h4 className="drawer-section-title">AÇIKLAMA</h4>
              <p className="drawer-text">{task.description}</p>
            </section>
          ) : null}

          {acceptanceCriteria.length > 0 ? (
            <section className="drawer-section">
              <h4 className="drawer-section-title">KABUL KRİTERLERİ</h4>
              <ul className="drawer-list">
                {acceptanceCriteria.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="drawer-section">
            <h4 className="drawer-section-title">SORUMLU AGENTLAR</h4>
            <div className="drawer-meta-grid">
              <div>
                <span className="drawer-meta-label">Atayan (Issuer)</span>
                <strong className="drawer-meta-val">{task.issuer_agent_id ? task.issuer_agent_id.slice(0, 8) : "PM Agent"}</strong>
              </div>
              <div>
                <span className="drawer-meta-label">Yapan (Worker)</span>
                <strong className="drawer-meta-val">{task.worker_agent_id ? task.worker_agent_id.slice(0, 8) : "Atanmadı"}</strong>
              </div>
              <div>
                <span className="drawer-meta-label">Denetleyen (Verifier)</span>
                <strong className="drawer-meta-val">{task.verifier_agent_id ? task.verifier_agent_id.slice(0, 8) : "—"}</strong>
              </div>
            </div>
          </section>

          <section className="drawer-section">
            <h4 className="drawer-section-title">KAYNAK & BÜTÇE</h4>
            <div className="drawer-meta-grid">
              <div>
                <span className="drawer-meta-label">Harcanan Token</span>
                <strong className="drawer-meta-val">{task.tokens_spent ? String(task.tokens_spent) : "0"}</strong>
              </div>
              <div>
                <span className="drawer-meta-label">Token Bütçesi</span>
                <strong className="drawer-meta-val">{task.token_budget ? String(task.token_budget) : "Limitsiz"}</strong>
              </div>
              <div>
                <span className="drawer-meta-label">Deneme</span>
                <strong className="drawer-meta-val">{task.attempt ?? 0} / {task.max_attempts ?? 3}</strong>
              </div>
            </div>
          </section>

          {targetFiles.length > 0 ? (
            <section className="drawer-section">
              <h4 className="drawer-section-title">HEDEF DOSYALAR</h4>
              <div className="drawer-tags">
                {targetFiles.map((file, i) => (
                  <button
                    key={i}
                    type="button"
                    className="drawer-tag-file"
                    onClick={() => onSelectFile?.(file)}
                  >
                    📄 {file}
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          {taskFindings.length > 0 ? (
            <section className="drawer-section">
              <h4 className="drawer-section-title">DENETİM BULGULARI ({taskFindings.length})</h4>
              <div className="drawer-findings">
                {taskFindings.map((f, i) => (
                  <div key={i} className={`drawer-finding-item drawer-finding--${f.severity}`}>
                    <strong>[{f.severity.toUpperCase()}] {f.title}</strong>
                    <p>{f.description}</p>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {taskMessages.length > 0 ? (
            <section className="drawer-section">
              <h4 className="drawer-section-title">MESAJ & OLAY GEÇMİŞİ ({taskMessages.length})</h4>
              <div className="drawer-messages">
                {taskMessages.map((m) => (
                  <div key={m.messageId} className="drawer-message-row">
                    <span className="pill pill--mini">{m.kind}</span>
                    <p className="drawer-msg-text">{m.payload?.text ?? "(içerik yok)"}</p>
                    <small className="chat-time">{new Date(m.createdAt || Date.now()).toLocaleTimeString("tr-TR")}</small>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
