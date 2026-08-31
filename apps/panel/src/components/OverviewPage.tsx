import React from "react";
import { taskStatusLabel, isTaskRunning, isTaskDone } from "../services/task-status.js";
import { RequirementWizard } from "./RequirementWizard.js";
import { ProjectControls } from "./ProjectControls.js";
import { PlanApprovalCard } from "./PlanApprovalCard.js";
import { PhaseProgressCard } from "./PhaseProgressCard.js";
import type { Task, Project } from "../services/projects.js";
import type { BudgetState } from "../services/budget.js";
import type { PageId } from "../services/routes.js";
import type { TimelineEvent } from "../viewmodels/workspace-logic.js";
import type { Plan } from "../services/plans.js";

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
  onReplan,
  plan,
  events,
  onStatusChange,
  screenContext,
  onSelectTask,
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
  readonly onReplan?: ((reason: string, summary: string) => void) | undefined;
  readonly plan?: Plan | undefined;
  readonly events?: readonly TimelineEvent[] | undefined;
  readonly onStatusChange?: ((status: "running" | "paused" | "archived") => void) | undefined;
  readonly screenContext?: string | undefined;
  readonly onSelectTask?: ((taskId: string) => void) | undefined;
}) {
  const completedTasks = tasks.filter((t) => isTaskDone(t.status)).length;
  const totalTasks = tasks.length;
  const taskProgressPct = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

  const runningTasks = tasks.filter((t) => isTaskRunning(t.status));
  const cost = budget?.spentUsd;
  const limit = budget?.limitUsd ?? 0;
  const questionsCount = pendingQuestionsCount ?? 0;

  const recentEvents = (events ?? []).slice(0, 5);
  const isPlanningPhase = project?.status === "planning" || project?.status === "gathering" || (plan && plan.status === "proposed");

  return (
    <div className="overview-page">
      <div className="overview-grid">
        <div className="overview-main">
          {project && onStatusChange ? (
            <div className="overview-project-header">
              <h2 className="overview-project-title">{project.name}</h2>
              <ProjectControls status={project.status} onStatus={onStatusChange} />
            </div>
          ) : null}

          {/* KPI Kartları - Tamamı klavyeyle odaklanabilir button */}
          <div className="kpi-grid">
            <button
              type="button"
              className="kpi-card"
              onClick={() => onNavigate("tasks")}
              aria-label="Tamamlanan görevler listesine git"
            >
              <span className="kpi-label">TAMAMLANAN GÖREVLER</span>
              <div className="kpi-value">
                <strong>
                  {completedTasks}/{totalTasks}
                </strong>
                <span className="kpi-sub">%{taskProgressPct}</span>
              </div>
              <div className="kpi-meter">
                <div
                  className="kpi-meter-fill"
                  style={{ width: `${taskProgressPct}%` }}
                />
              </div>
            </button>

            <button
              type="button"
              className="kpi-card"
              onClick={() => onNavigate("tasks")}
              aria-label="Çalışan görevler listesine git"
            >
              <span className="kpi-label">ÇALIŞAN GÖREVLER</span>
              <div className="kpi-value">
                <strong>{runningTasks.length}</strong>
                <span className="kpi-sub">görev</span>
              </div>
              <p className="kpi-meta">
                {runningTasks.length > 0 ? `${runningTasks.length} görev icra ediliyor` : "Aktif görev yok"}
              </p>
            </button>

            <button
              type="button"
              className={`kpi-card ${questionsCount > 0 ? "kpi-card--warning" : ""}`}
              onClick={() => onNavigate("chat")}
              aria-label="Bekleyen sorulara git"
            >
              <span className="kpi-label">SENİ BEKLEYEN</span>
              <div className="kpi-value">
                <strong>{questionsCount}</strong>
                <span className="kpi-sub">Soru</span>
              </div>
              <p className="kpi-meta">
                {questionsCount > 0 ? "Cevap bekleyen sorular var" : "Bekleyen soru yok"}
              </p>
            </button>

            <button
              type="button"
              className="kpi-card"
              onClick={() => onNavigate("budget")}
              aria-label="Kontör panosuna git"
            >
              <span className="kpi-label">TOPLAM HARCAMA</span>
              <div className="kpi-value">
                <strong>{cost !== undefined ? `$${cost.toFixed(4)}` : "—"}</strong>
              </div>
              <p className="kpi-meta">
                {limit > 0 ? `Limit: $${limit.toFixed(2)}` : "Limit tanımlanmadı"}
              </p>
            </button>
          </div>

          {/* Faz İlerlemesi — faz verisi için CH'de ayrı tablo/alan yok;
              phases prop geldiğinde render edilir, şu an çizilmez. */}
          <PhaseProgressCard />

          {/* Gereksinim Toplama Sihirbazı */}
          {project?.status === "gathering" ? (
            <div className="card overview-card overview-wizard-card">
              <RequirementWizard projectId={project.project_id} />
            </div>
          ) : null}

          {/* Plan Onay Kartı */}
          {isPlanningPhase && plan ? (
            <PlanApprovalCard
              plan={plan}
              onApprove={onApprovePlan}
              onReplan={onReplan}
            />
          ) : null}

          {/* Şu an çalışan görevler */}
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
                  <button
                    key={t.task_id}
                    type="button"
                    className="running-task-item"
                    onClick={() => onSelectTask?.(t.task_id)}
                  >
                    <div className="task-info">
                      <strong>{t.title}</strong>
                      <small className="mono-address">ID: {t.task_id.slice(0, 8)}</small>
                    </div>
                    <span className="pill pill--running">{taskStatusLabel(t.status)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Son Olaylar */}
          <div className="card overview-card">
            <div className="card-header">
              <h3>Son Olaylar (Canlı Akış)</h3>
              <button
                type="button"
                className="linklike"
                onClick={() => onNavigate("canvas")}
              >
                Tüm zaman çizelgesi →
              </button>
            </div>
            {recentEvents.length === 0 ? (
              <p className="hint">Henüz kaydedilmiş bir olay yok.</p>
            ) : (
              <ul className="timeline-event-list">
                {recentEvents.map((ev) => (
                  <li key={ev.cursor} className="timeline-event-item">
                    <span className="pill pill--mini">{ev.event}</span>
                    <span className="event-summary">
                      {typeof ev.data === 'object' && ev.data !== null && 'summary' in ev.data
                        ? String((ev.data as { summary?: unknown }).summary ?? ev.event)
                        : ev.event}
                    </span>
                    <small className="chat-time">{new Date(ev.ts).toLocaleTimeString("tr-TR")}</small>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Sağ Ray */}
        <aside className="overview-sidebar">
          {/* Eylem Odaklı Soru Kutusu (Sayı tekrarı yok, doğrudan eylem sunar) */}
          {questionsCount > 0 ? (
            <div className="sidebar-warning-card">
              <div className="sidebar-warning-head">
                <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="#f59e0b" strokeWidth="1.6">
                  <path d="M8 1.75l5.5 2.5v4c0 3-2.4 5.3-5.5 6-3.1-.7-5.5-3-5.5-6v-4z" />
                  <path d="M8 5.5v3M8 11.5h.01" />
                </svg>
                <strong>Agent Soruları Bekliyor</strong>
              </div>
              <p className="hint">
                Görevlerin devam edebilmesi için soruları yanıtlayın.
              </p>
              <button
                type="button"
                className="btn btn--secondary btn--full"
                onClick={() => onNavigate("chat")}
              >
                Soruları Yanıtla →
              </button>
            </div>
          ) : null}

          {/* PM Sohbet Rayı */}
          <div className="card chat-rail-card">
            <div className="card-header">
              <h3>PM Sohbeti</h3>
              <button
                type="button"
                className="linklike"
                onClick={() => onNavigate("chat")}
              >
                Tam ekran ↗
              </button>
            </div>
            <p className="hint">Projeyi yönlendirmek için PM agent'a doğrudan emir verin:</p>
            {screenContext ? (
              <div className="chat-rail-context-container">
                <span className="pill pill--mini pill--context">
                  Bağlam: {screenContext}
                </span>
              </div>
            ) : null}
            <div className="chat-rail-composer">
              <input
                type="text"
                aria-label="PM hızlı emir"
                placeholder="Örn: Butonun rengini zümrüt yeşili yap"
                value={commandDraft ?? ""}
                onChange={(e) => onCommandDraft?.(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && commandDraft?.trim()) {
                    e.preventDefault();
                    onCommand?.();
                  }
                }}
              />
              <button
                type="button"
                className="btn btn--primary"
                onClick={onCommand}
                disabled={!commandDraft?.trim()}
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
