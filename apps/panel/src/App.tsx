import React, { useMemo, useCallback } from "react";
import type { OrgPlan } from "@ww/shared";
import { useHealth } from "./viewmodels/useHealth.js";
import { useWorkspaceViewModel } from "./viewmodels/useWorkspaceViewModel.js";
import { useRouterViewModel } from "./viewmodels/useRouterViewModel.js";
import { useCommandPaletteViewModel } from "./viewmodels/useCommandPaletteViewModel.js";
import { useScreenContextViewModel } from "./viewmodels/useScreenContextViewModel.js";
import { useKeyboardShortcuts } from "./viewmodels/useKeyboardShortcuts.js";
import { AppShell } from "./components/AppShell.js";
import { CommandPalette } from "./components/CommandPalette.js";
import { NotificationBell } from "./components/NotificationBell.js";
import { OverviewPage } from "./components/OverviewPage.js";
import { CanvasPanel } from "./components/CanvasPanel.js";
import { TasksPage } from "./components/TasksPage.js";
import { FileBrowserPanel } from "./components/FileBrowserPanel.js";
import { ChatPage } from "./components/ChatPage.js";
import { PreviewPage } from "./components/PreviewPage.js";
import { ProjectPicker } from "./components/ProjectPicker.js";
import { ProvidersPage } from "./components/ProvidersPage.js";
import { BudgetPanel } from "./components/BudgetPanel.js";
import { AuditPanel } from "./components/AuditPanel.js";
import { SettingsPage } from "./components/SettingsPage.js";
import { TaskDetailDrawer } from "./components/TaskDetailDrawer.js";
import { ToastProvider, useToast } from "./components/Toast.js";
import { isTaskRunning } from "./services/task-status.js";

function AppContent() {
  const { health } = useHealth();
  const { currentPage, navigate } = useRouterViewModel();
  const vm = useWorkspaceViewModel();
  const toast = useToast();
  const screen = useScreenContextViewModel(currentPage);

  const activeProject = vm.projects.find((p) => p.project_id === vm.projectId);
  const activeTask = useMemo(() => {
    return vm.tasks.find((t) => t.task_id === vm.selectedTaskId);
  }, [vm.tasks, vm.selectedTaskId]);

  const handleApprovePlan = useCallback(async () => {
    try {
      // BİLDİRİM İŞLEMİN SONUCUNU SÖYLER. Eskiden "Görevler yürütmeye alındı"
      // yazıyordu ama onay hiçbir görev üretmiyordu; kuyruk boş kalıyordu.
      const createdTaskCount = await vm.approveCurrentPlan();
      toast.success(
        `Plan onaylandı. ${createdTaskCount} görev yürütmeye alındı.`,
        "Plan Onaylandı",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Plan onaylanamadı", "Hata");
    }
  }, [vm, toast]);

  const handleReplan = useCallback(async (reason: string, summary: string) => {
    try {
      await vm.replanCurrentProject(reason, summary);
      toast.success("Yeniden planlama talebi PM agent'a iletildi.", "Revizyon Talebi");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Revizyon talebi iletilemedi", "Hata");
    }
  }, [vm, toast]);

  const handleSendCommand = useCallback(async () => {
    try {
      await vm.sendCommand(screen.contextFor());
      toast.success("Emir PM agent'a iletildi.", "Emir Gönderildi");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Emir gönderilemedi", "Hata");
    }
  }, [vm, screen, toast]);

  const handleStatusChange = useCallback(async (status: "running" | "paused" | "archived") => {
    try {
      await vm.updateProjectStatus(status);
      toast.info(`Proje durumu güncellendi: ${status}`, "Durum Güncellendi");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Durum güncellenemedi", "Hata");
    }
  }, [vm, toast]);

  const palette = useCommandPaletteViewModel({
    onNavigate: navigate,
    projects: vm.projects,
    onSelectProject: vm.setProjectId,
    ...(vm.activePlan?.status === "proposed" ? { onApprovePlan: handleApprovePlan } : {}),
  });

  useKeyboardShortcuts({
    onNavigate: navigate,
    onCloseModals: () => {
      palette.closePalette();
      vm.setSelectedTaskId(undefined);
    },
  });

  const runningTasksCount = vm.tasks.filter((t) => isTaskRunning(t.status)).length;
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
            onCommand={handleSendCommand}
            commandDraft={vm.message}
            onCommandDraft={vm.setMessage}
            onApprovePlan={handleApprovePlan}
            onReplan={handleReplan}
            plan={vm.activePlan}
            events={vm.events}
            onStatusChange={handleStatusChange}
            screenContext={screen.contextFor()}
            onSelectTask={vm.setSelectedTaskId}
          />
        );
      case "canvas":
        const parsedTeam = typeof vm.activePlan?.team_json === "string"
          ? (() => { try { return JSON.parse(vm.activePlan.team_json); } catch { return undefined; } })()
          : vm.activePlan?.team_json;
        const currentOrgPlan = (parsedTeam as { org_plan?: OrgPlan } | undefined)?.org_plan;
        return (
          <CanvasPanel
            projectId={vm.projectId}
            orgPlan={currentOrgPlan}
            planContentMd={vm.activePlan?.content_md || vm.plans[0]?.content_md}
            events={vm.events}
            cursor={vm.timelineCursor}
            onCursor={vm.setTimelineCursor}
            at={vm.replay?.at}
            tasks={vm.tasks}
            statusByTask={
              Number.isFinite(vm.timelineCursor) && vm.timelineCursor < vm.events.length
                ? vm.replay?.statusByTask
                : undefined
            }
            selectedAgent={vm.selectedAgent}
            onSelectAgent={vm.setSelectedAgent}
          />
        );
      case "tasks":
        return (
          <TasksPage
            tasks={vm.tasks}
            onSelectTask={vm.setSelectedTaskId}
          />
        );
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
            onSelectTask={vm.setSelectedTaskId}
            tasks={vm.tasks}
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
      health={health ? { clickhouse: health.clickhouse, redis: health.redis, api: true } : undefined}
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

      <TaskDetailDrawer
        task={activeTask}
        onClose={() => vm.setSelectedTaskId(undefined)}
        findings={vm.auditReport.recordFindings}
        artifacts={vm.apiArtifacts}
        agents={[]}
        onSelectFile={(path) => {
          vm.setSelectedFile(path);
          navigate("files");
          vm.setSelectedTaskId(undefined);
        }}
      />

      {renderPage()}
    </AppShell>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <AppContent />
    </ToastProvider>
  );
}
