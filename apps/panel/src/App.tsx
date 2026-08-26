import { useHealth } from "./viewmodels/useHealth.js";
import { useWorkspaceViewModel } from "./viewmodels/useWorkspaceViewModel.js";
import { useRouterViewModel } from "./viewmodels/useRouterViewModel.js";
import { useCommandPaletteViewModel } from "./viewmodels/useCommandPaletteViewModel.js";
import { useScreenContextViewModel } from "./viewmodels/useScreenContextViewModel.js";
import { AppShell } from "./components/AppShell.js";
import { CommandPalette } from "./components/CommandPalette.js";
import { NotificationBell } from "./components/NotificationBell.js";
import { OverviewPage } from "./components/OverviewPage.js";
import { CanvasPanel } from "./components/CanvasPanel.js";
import { TaskListPanel } from "./components/TaskListPanel.js";
import { FileBrowserPanel } from "./components/FileBrowserPanel.js";
import { ChatPage } from "./components/ChatPage.js";
import { PreviewPage } from "./components/PreviewPage.js";
import { ProjectPicker } from "./components/ProjectPicker.js";
import { ProvidersPage } from "./components/ProvidersPage.js";
import { BudgetPanel } from "./components/BudgetPanel.js";
import { AuditPanel } from "./components/AuditPanel.js";
import { SettingsPage } from "./components/SettingsPage.js";

export default function App() {
  const { health } = useHealth();
  const { currentPage, navigate } = useRouterViewModel();
  const vm = useWorkspaceViewModel();
  const screen = useScreenContextViewModel(currentPage);
  const palette = useCommandPaletteViewModel({ onNavigate: navigate, projects: vm.projects, onSelectProject: vm.setProjectId });
  const activeProject = vm.projects.find((p) => p.project_id === vm.projectId);

  const runningTasksCount = vm.tasks.filter((t) => t.status === "running" || t.status === "active" || t.status === "working").length;
  const auditWarningsCount = (vm.auditReport.counts.open ?? 0) + (vm.auditReport.counts.correction_pending ?? 0);

  function renderPage() {
    switch (currentPage) {
      case "overview":
        return (
          <OverviewPage
            project={activeProject}
            tasks={vm.tasks}
            budget={vm.budgetReport.budget}
            pendingQuestionsCount={vm.pendingQuestionsCount}
            onNavigate={navigate}
            onCommand={() => void vm.sendCommand(screen.contextFor())}
            commandDraft={vm.message}
            onCommandDraft={vm.setMessage}
            events={vm.events}
            onStatusChange={vm.updateProjectStatus}
            screenContext={screen.contextFor()}
          />
        );
      case "canvas":
        return (
          <CanvasPanel
            projectId={vm.projectId}
            events={vm.events}
            cursor={vm.timelineCursor}
            onCursor={vm.setTimelineCursor}
            at={vm.replay?.at}
            tasks={vm.tasks}
            statusByTask={vm.replay?.statusByTask}
            selectedAgent={vm.selectedAgent}
            onSelectAgent={vm.setSelectedAgent}
          />
        );
      case "tasks":
        return <TaskListPanel tasks={vm.tasks} statusCounts={vm.statusCounts} />;
      case "files":
        return (
          <FileBrowserPanel
            projectId={vm.projectId}
            files={vm.files}
            selectedFile={vm.selectedFile}
            onSelectFile={vm.setSelectedFile}
            narratorQuestion={vm.narratorQuestion}
            onNarratorQuestion={vm.setNarratorQuestion}
            onAskNarrator={() => void vm.askNarrator()}
            narratorResult={vm.narratorResult ?? undefined}
          />
        );
      case "chat":
        return <ChatPage projectId={vm.projectId} />;
      case "preview":
        return (
          <PreviewPage
            projectId={vm.projectId}
            artifacts={vm.apiArtifacts}
            onActiveUrl={screen.setActiveUrl}
            onActiveSession={screen.setActiveSession}
          />
        );
      case "projects":
        return (
          <ProjectPicker
            projects={vm.projects}
            draft={vm.projectDraft}
            onDraft={(p) => vm.setProjectDraft((c) => ({ ...c, ...p }))}
            onCreate={() => void vm.createProject()}
            statusMessage={vm.projectStatusMessage}
            onSelect={(id) => { vm.setProjectId(id); navigate("overview"); }}
            loadError={vm.projectsError}
            expressPrompt={vm.expressPrompt}
            onExpressPrompt={vm.setExpressPrompt}
            expressName={vm.expressName}
            onExpressName={vm.setExpressName}
            onExpressCreate={() => void vm.createExpressProject()}
          />
        );
      case "providers":
        return <ProvidersPage />;
      case "budget":
        return <BudgetPanel projectId={vm.projectId} />;
      case "audit":
        return <AuditPanel projectId={vm.projectId} />;
      case "settings":
        return <SettingsPage />;
    }
  }

  return (
    <AppShell
      currentPage={currentPage}
      onNavigate={navigate}
      onOpenCommandPalette={palette.openPalette}
      connection={vm.connection}
      eventsCount={vm.events.length}
      projects={vm.projects}
      selectedProjectId={vm.projectId}
      onSelectProject={vm.setProjectId}
      budget={vm.budgetReport.budget}
      health={health ? { clickhouse: health.clickhouse, redis: health.redis } : undefined}
      counts={{
        pendingQuestions: vm.pendingQuestionsCount,
        runningTasks: runningTasksCount,
        auditWarnings: auditWarningsCount,
      }}
      topBarActions={
        <NotificationBell
          signals={{
            budget: vm.budgetReport.budget,
            providers: vm.providerList,
            tasks: vm.tasks,
            escalations: vm.auditReport.escalations,
            recordFindings: vm.auditReport.recordFindings,
          }}
        />
      }
    >
      <CommandPalette
        isOpen={palette.isOpen}
        onClose={palette.closePalette}
        query={palette.query}
        onQueryChange={palette.setQuery}
        actions={palette.filteredActions}
        selectedIndex={palette.selectedIndex}
        onSelectIndex={palette.setSelectedIndex}
      />
      {renderPage()}
    </AppShell>
  );
}
