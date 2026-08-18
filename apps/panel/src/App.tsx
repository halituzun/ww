// Çalışma alanı ekranı — SALT GÖRÜNÜM (docs/09 MVVM).
//
// Durum, veri yükleme, yoklama, canlı bağlantı ve eylemler
// `useWorkspaceViewModel` içindedir; burada iş mantığı bulunmaz.
import { useHealth } from './viewmodels/useHealth.js';
import { useScreenContextViewModel } from './viewmodels/useScreenContextViewModel.js';
import { TabBar } from './components/TabBar.js';
import { TopBar } from './components/TopBar.js';
import { ProjectControls } from './components/ProjectControls.js';
import { ProviderHealthBadges, UsageMetrics } from './components/UsageMetrics.js';
import { WorkspaceTabs } from './components/WorkspaceTabs.js';
import { ProjectPicker } from './components/ProjectPicker.js';
import { ProvidersPage } from './components/ProvidersPage.js';
import { BudgetPanel } from './components/BudgetPanel.js';
import { PendingQuestions } from './components/PendingQuestions.js';
import { RequirementWizard } from './components/RequirementWizard.js';
import { AuditPanel } from './components/AuditPanel.js';
import { NotificationBell } from './components/NotificationBell.js';
import { useWorkspaceViewModel } from './viewmodels/useWorkspaceViewModel.js';

export default function App() {
  const { health, state, status } = useHealth();
  const {
    page, setPage,
    projectId, setProjectId,
    budgetReport, auditReport, providerList,
    tasks, projects, projectsError, workspaceError, projectDraft, setProjectDraft,
    projectStatusMessage, projectStatus,
    usage, files, providerHealth, apiArtifacts,
    timelineCursor, setTimelineCursor, replay,
    selectedAgent, setSelectedAgent,
    selectedFile, setSelectedFile,
    events, connection, statusCounts,
    message, setMessage, messageStatus,
    narratorQuestion, setNarratorQuestion, narratorResult,
    tab, setTab,
    sendCommand, askNarrator, updateProjectStatus, createProject,
  } = useWorkspaceViewModel();

  // docs/10 ekran bağlamı; durum ViewModel'de, View yalnız geçirir.
  const screen = useScreenContextViewModel(tab);

  if (page === 'providers') {
    return (
      <main className="shell">
        <TopBar title="API sağlayıcıları" onBack={() => setPage('workspace')} />
        <ProvidersPage />
      </main>
    );
  }

  return (
    <main className="shell">
      <TopBar
        title="Agent çalışma alanı"
        connection={connection}
        projectId={projectId}
        onProjectId={setProjectId}
        onProviders={() => setPage('providers')}
      >
        <NotificationBell signals={{
          budget: budgetReport.budget,
          providers: providerList,
          tasks,
          escalations: auditReport.escalations,
          recordFindings: auditReport.recordFindings,
        }} />
      </TopBar>

      <section className={`status-card status-card--${state}`} aria-live="polite">
        <div>
          <p className="status-label">Altyapı durumu</p>
          <h2>{status}</h2>
        </div>
        <span className="status-dot" aria-hidden="true" />

        {health ? (
          <dl>
            <div>
              <dt>ClickHouse</dt>
              <dd>{health.clickhouse ? 'Çalışıyor' : 'Kapalı'}</dd>
            </div>
            <div>
              <dt>Redis</dt>
              <dd>{health.redis ? 'Çalışıyor' : 'Kapalı'}</dd>
            </div>
          </dl>
        ) : null}
      </section>
      <section className="command-card">
        <label htmlFor="command">PM’e mesaj gönder</label>
        <div className="command-row"><input id="command" value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Bir sonraki adımı sor…" /><button type="button" onClick={() => void sendCommand(screen.contextFor())}>Gönder</button></div>
        {messageStatus ? <small>{messageStatus}</small> : null}
      </section>
      {projectId ? <section className="workspace-card">
        <ProjectControls status={projectStatus} onStatus={(next) => void updateProjectStatus(next)} />
        <RequirementWizard projectId={projectId} /><PendingQuestions projectId={projectId} /><BudgetPanel projectId={projectId} />
        <AuditPanel projectId={projectId} />
        <UsageMetrics usage={usage ?? undefined} />
        <ProviderHealthBadges providers={providerHealth} />
        <p className="hint">API sağlayıcıları ve anahtarlar <button type="button" className="linklike" onClick={() => setPage('providers')}>API'ler sayfasında</button> yönetilir.</p>
        {workspaceError === '' ? null : (
          <p className="audit-error" role="alert">{workspaceError}</p>
        )}
        <TabBar tab={tab} onTab={setTab} counts={{ tasks: tasks.length, events: events.length }} />
        <WorkspaceTabs
          tab={tab}
          projectId={projectId}
          tasks={tasks}
          statusCounts={statusCounts}
          events={events}
          timelineCursor={timelineCursor}
          onTimelineCursor={setTimelineCursor}
          replay={replay}
          files={files}
          selectedFile={selectedFile}
          onSelectFile={setSelectedFile}
          selectedAgent={selectedAgent}
          onSelectAgent={setSelectedAgent}
          narratorQuestion={narratorQuestion}
          onNarratorQuestion={setNarratorQuestion}
          onAskNarrator={() => void askNarrator()}
          narratorResult={narratorResult ?? undefined}
          apiArtifacts={apiArtifacts}
          onActiveUrl={screen.setActiveUrl}
          onActiveSession={screen.setActiveSession}
        />
      </section> : <ProjectPicker projects={projects} draft={projectDraft} onDraft={(patch) => setProjectDraft((current) => ({ ...current, ...patch }))} onCreate={() => void createProject()} statusMessage={projectStatusMessage} onSelect={setProjectId} loadError={projectsError} />}
    </main>
  );
}
