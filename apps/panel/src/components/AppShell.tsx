import type { ReactNode } from "react";
import { SideNav, type HealthSummary } from "./SideNav.js";
import { TopBar } from "./TopBar.js";
import { pageTitle, type PageId } from "../services/routes.js";
import type { ConnectionState } from "../viewmodels/live-connection.js";
import type { Project } from "../services/projects.js";
import type { BudgetState } from "../services/budget.js";

export function AppShell({
  currentPage,
  onNavigate,
  onOpenCommandPalette,
  connection,
  eventsCount,
  projects,
  selectedProjectId,
  onSelectProject,
  budget,
  counts,
  health,
  topBarActions,
  children,
}: {
  readonly currentPage: PageId;
  readonly onNavigate: (page: PageId) => void;
  readonly onOpenCommandPalette?: (() => void) | undefined;
  readonly connection?: ConnectionState | undefined;
  readonly eventsCount?: number | undefined;
  readonly projects?: readonly Project[] | undefined;
  readonly selectedProjectId?: string | undefined;
  readonly onSelectProject?: ((projectId: string) => void) | undefined;
  readonly budget?: { readonly state: BudgetState; readonly ratio: number; readonly spentUsd: number; readonly limitUsd: number } | undefined;
  readonly counts?: {
    readonly pendingQuestions?: number | undefined;
    readonly runningTasks?: number | undefined;
    readonly auditWarnings?: number | undefined;
  } | undefined;
  readonly health?: HealthSummary | undefined;
  readonly topBarActions?: ReactNode | undefined;
  readonly children: ReactNode;
}) {
  return (
    <div className="app-shell">
      <SideNav
        currentPage={currentPage}
        onNavigate={onNavigate}
        onOpenCommandPalette={onOpenCommandPalette}
        counts={counts}
        health={health}
      />
      <div className="app-main-wrapper">
        <TopBar
          title={pageTitle(currentPage)}
          connection={connection}
          eventsCount={eventsCount}
          projects={projects}
          selectedProjectId={selectedProjectId}
          onSelectProject={onSelectProject}
          onNewProject={() => onNavigate("projects")}
          budget={budget}
          onNavigate={onNavigate}
        >
          {topBarActions}
        </TopBar>
        <main className="app-main-content">{children}</main>
      </div>
    </div>
  );
}
