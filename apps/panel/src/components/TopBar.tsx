import type { ReactNode } from "react";
import { connectionLabel, type ConnectionState } from "../viewmodels/live-connection.js";
import { BudgetBadge } from "./BudgetBadge.js";
import { ProjectSwitcher } from "./ProjectSwitcher.js";
import type { Project } from "../services/projects.js";
import type { BudgetState } from "../services/budget.js";
import type { PageId } from "../services/routes.js";

export function TopBar({
  title,
  connection,
  eventsCount,
  projects,
  selectedProjectId,
  onSelectProject,
  onNewProject,
  budget,
  onNavigate,
  projectId,
  onProjectId,
  onProviders,
  onBack,
  children,
}: {
  readonly title: string;
  readonly connection?: ConnectionState | undefined;
  readonly eventsCount?: number | undefined;
  readonly projects?: readonly Project[] | undefined;
  readonly selectedProjectId?: string | undefined;
  readonly onSelectProject?: ((next: string) => void) | undefined;
  readonly onNewProject?: (() => void) | undefined;
  readonly budget?: { readonly state: BudgetState; readonly ratio: number; readonly spentUsd: number; readonly limitUsd: number } | undefined;
  readonly onNavigate?: ((page: PageId) => void) | undefined;
  readonly projectId?: string | undefined;
  readonly onProjectId?: ((next: string) => void) | undefined;
  readonly onProviders?: (() => void) | undefined;
  readonly onBack?: (() => void) | undefined;
  readonly children?: ReactNode | undefined;
}) {
  return (
    <header className="topbar">
      {projects && onSelectProject ? (
        <ProjectSwitcher
          projects={projects}
          selectedProjectId={selectedProjectId ?? ""}
          onSelectProject={onSelectProject}
          onNewProject={onNewProject}
        />
      ) : (
        <div className="topbar-title-legacy">
          <p className="eyebrow">ww / ORCHESTRATION</p>
          <h1>{title}</h1>
        </div>
      )}

      {projects && onSelectProject ? (
        <>
          <div className="topbar-divider" />
          <span className="topbar-page-title">{title}</span>
        </>
      ) : null}

      <div className="topbar-actions">
        {budget ? (
          <BudgetBadge budget={budget} onClick={() => onNavigate?.("budget")} />
        ) : null}

        {connection !== undefined ? (
          <span className={`conn conn--${connection}`} title="Canlı olay bağlantısı">
            <span className="conn__dot" aria-hidden="true" />
            <span>
              {connectionLabel(connection)}
              {eventsCount && eventsCount > 0 && connection === "open" ? ` · ${eventsCount} olay` : ""}
            </span>
          </span>
        ) : null}

        {onBack ? (
          <button type="button" className="btn btn--secondary" onClick={onBack}>
            ← Çalışma alanı
          </button>
        ) : null}

        {onProviders ? (
          <button type="button" className="btn btn--secondary" onClick={onProviders}>
            API&apos;ler
          </button>
        ) : null}

        {children}

        {onProjectId ? (
          <input
            aria-label="Proje kimliği"
            placeholder="Proje UUID"
            value={projectId ?? ""}
            onChange={(event) => onProjectId(event.target.value)}
          />
        ) : null}
      </div>
    </header>
  );
}
