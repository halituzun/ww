import { taskStatusLabel } from "../services/task-status.js";
import { RequirementWizard } from "./RequirementWizard.js";
import { ProjectControls } from "./ProjectControls.js";
import type { Task, Project } from "../services/projects.js";
import type { BudgetState } from "../services/budget.js";
import type { PageId } from "../services/routes.js";
import type { TimelineEvent } from "../viewmodels/workspace-logic.js";

export function OverviewPage({
  project,
  tasks,
  budget,
  pendingQuestionsCount,
  onNavigate,
  onCommand,
  commandDraft,
  onCommandDraft,
  onApprovePlan,
  events,
  onStatusChange,
  screenContext,
}: {
  readonly project: Project | undefined;
  readonly tasks: readonly Task[];
  readonly budget: { readonly state: BudgetState; readonly ratio: number; readonly spentUsd: number; readonly limitUsd: number } | undefined;
  readonly pendingQuestionsCount?: number | undefined;
  readonly onNavigate: (page: PageId) => void;
  readonly onCommand?: (() => void) | undefined;
  readonly commandDraft?: string | undefined;
  readonly onCommandDraft?: ((val: string) => void) | undefined;
  readonly onApprovePlan?: (() => void) | undefined;
  readonly events?: readonly TimelineEvent[] | undefined;
  readonly onStatusChange?: ((status: "running" | "paused" | "archived") => void) | undefined;
  readonly screenContext?: string | undefined;
}) {
  const completedTasks = tasks.filter((t) => t.status === "done" || t.status === "completed").length;
  const totalTasks = tasks.length;
  const taskProgressPct = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

  const runningTasks = tasks.filter((t) => t.status === "running" || t.status === "active");
  const cost = budget?.spentUsd;
  const limit = budget?.limitUsd ?? 0;
  const questionsCount = pendingQuestionsCount ?? 0;

  const recentEvents = (events ?? []).slice(0, 5);
  const isPlanningPhase = project?.status === "planning" || project?.status === "gathering";

  return (
    <div className="overview-page">
      <div className="overview-grid">
        <div className="overview-main">
          {project && onStatusChange ? (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
              <h2 style={{ margin: 0, fontSize: "18px", color: "#f1f5f9" }}>{project.name}</h2>
              <ProjectControls status={project.status} onStatus={onStatusChange} />
            </div>
          ) : null}
          <div className="kpi-grid">
            <div className="kpi-card" onClick={() => onNavigate("tasks")}>
              <span className="kpi-label">TAMAMLANAN GÖREVLER</span>
              <div className="kpi-value">
                <strong>{totalTasks > 0 ? `${completedTasks}/${totalTasks}` : "0"}</strong>
                <span className="kpi-sub">%{taskProgressPct}</span>
              </div>
              <div className="kpi-meter">
                <div className="kpi-meter-fill" style={{ width: `${taskProgressPct}%` }} />
              </div>
            </div>

            <div className="kpi-card" onClick={() => onNavigate("canvas")}>
              <span className="kpi-label">AKTİF AGENT'LAR</span>
              <div className="kpi-value">
                <strong>{runningTasks.length}</strong>
                <span className="kpi-sub">görevde</span>
              </div>
              <p className="kpi-meta">{runningTasks.length > 0 ? `${runningTasks.length} görev yürütülüyor` : "Aktif görev yok"}</p>
            </div>

            <div
              className={`kpi-card ${questionsCount > 0 ? "kpi-card--warning" : ""}`}
              onClick={() => onNavigate("chat")}
            >
              <span className="kpi-label">SENİ BEKLEYEN</span>
              <div className="kpi-value">
                <strong>{questionsCount}</strong>
                <span className="kpi-sub">Soru</span>
              </div>
              <p className="kpi-meta">
                {questionsCount > 0 ? "Cevap bekleyen sorular var" : "Bekleyen soru yok"}
              </p>
            </div>

            <div className="kpi-card" onClick={() => onNavigate("budget")}>
              <span className="kpi-label">BUGÜN HARCANAN</span>
              <div className="kpi-value">
                <strong>{cost !== undefined ? `$${cost.toFixed(4)}` : "Bilinmiyor"}</strong>
              </div>
              <p className="kpi-meta">
                {limit > 0 ? `Limit: $${limit.toFixed(2)}` : "Limit: Sınırsız"}
              </p>
            </div>
          </div>

          {project?.status === "gathering" ? (
            <div className="card overview-card" style={{ marginBottom: "16px" }}>
              <RequirementWizard projectId={project.project_id} />
            </div>
          ) : isPlanningPhase && onApprovePlan ? (
            <div className="plan-approval-hero-card">
              <div className="plan-approval-header">
                <span className="plan-badge">PLAN ONAYI BEKLİYOR</span>
                <h3>Mühendislik ve Görev Planı Hazır</h3>
              </div>
              <p className="hint">
                Agent konseyi gereksinimleri analiz etti ve görev DAG planını oluşturdu.
              </p>
              <div className="plan-approval-actions">
                <button type="button" className="btn btn--primary" onClick={onApprovePlan}>
                  Planı Onayla ve Başlat
                </button>
                <button type="button" className="btn btn--secondary" onClick={() => onNavigate("tasks")}>
                  Görev Planını İncele
                </button>
              </div>
            </div>
          ) : null}

          <div className="card overview-card">
            <div className="card-header">
              <h3>Şu An Çalışan Görevler</h3>
              <span className="badge badge--neutral">{runningTasks.length} Görev</span>
            </div>

            {runningTasks.length === 0 ? (
              <p className="hint">Şu anda çalışan aktif bir görev yok.</p>
            ) : (
              <div className="running-tasks-list">
                {runningTasks.map((t) => (
                  <div key={t.task_id} className="running-task-item">
                    <div className="running-task-info">
                      <span className="running-task-dot" />
                      <strong>{t.title || t.task_id}</strong>
                    </div>
                    <span className={`pill pill--${t.status}`}>{taskStatusLabel(t.status)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card overview-card">
            <div className="card-header">
              <h3>Son Olaylar (Canlı Akış)</h3>
              <button type="button" className="linklike" onClick={() => onNavigate("canvas")}>
                Tüm zaman çizelgesi →
              </button>
            </div>

            {recentEvents.length === 0 ? (
              <p className="hint">Henüz kaydedilmiş bir olay yok.</p>
            ) : (
              <div className="recent-events-list">
                {recentEvents.map((e: TimelineEvent, idx: number) => (
                  <div key={idx} className="event-item">
                    <span className="event-time">
                      {new Date(e.ts || Date.now()).toLocaleTimeString("tr-TR")}
                    </span>
                    <span className="event-type">{e.event}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <aside className="overview-sidebar">
          {questionsCount > 0 ? (
            <div className="sidebar-warning-card">
              <div className="sidebar-warning-head">
                <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="#f59e0b" strokeWidth="1.6">
                  <path d="M8 1.75l5.5 2.5v4c0 3-2.4 5.3-5.5 6-3.1-.7-5.5-3-5.5-6v-4z" />
                  <path d="M8 5.5v3M8 11.5h.01" />
                </svg>
                <strong>{questionsCount} Soru Seni Bekliyor</strong>
              </div>
              <p className="hint">Cevaplanmayan sorular ilgili görevleri bloke ediyor.</p>
              <button
                type="button"
                className="btn btn--secondary btn--full"
                onClick={() => onNavigate("chat")}
              >
                Soruları Cevapla →
              </button>
            </div>
          ) : null}

          <div className="card chat-rail-card">
            <div className="card-header">
              <h3>PM Sohbeti</h3>
              <button type="button" className="linklike" onClick={() => onNavigate("chat")}>
                Tam ekran ↗
              </button>
            </div>
            <p className="hint">Projeyi yönlendirmek için PM agent'a doğrudan emir verin:</p>
            {screenContext ? (
              <div style={{ marginBottom: "8px" }}>
                <span className="pill pill--mini" style={{ background: "rgba(56, 189, 248, 0.1)", color: "#38bdf8", border: "1px solid rgba(56, 189, 248, 0.2)" }}>
                  Bağlam: {screenContext}
                </span>
              </div>
            ) : null}
            <div className="chat-rail-composer">
              <input
                type="text"
                aria-label="PM hızlı emir" placeholder="Örn: Butonun rengini zümrüt yeşili yap"
                value={commandDraft ?? ""}
                onChange={(e) => onCommandDraft?.(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && commandDraft && commandDraft.trim() !== "") {
                    onCommand?.();
                  }
                }}
              />
              <button
                type="button"
                className="btn btn--primary"
                onClick={onCommand}
                disabled={!commandDraft || commandDraft.trim() === ""}
              >
                Gönder
              </button>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
