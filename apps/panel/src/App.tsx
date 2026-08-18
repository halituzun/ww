// Çalışma alanı ekranı — SALT GÖRÜNÜM (docs/09 MVVM).
//
// Durum, veri yükleme, yoklama, canlı bağlantı ve eylemler
// `useWorkspaceViewModel` içindedir; burada iş mantığı bulunmaz.
import { useHealth } from './viewmodels/useHealth.js';
import { TabBar } from './components/TabBar.js';
import { MobilePreviewPanel } from './components/MobilePreviewPanel.js';
import { ProjectPicker } from './components/ProjectPicker.js';
import { TaskListPanel } from './components/TaskListPanel.js';
import { TimelinePanel } from './components/TimelinePanel.js';
import { CanvasPanel } from './components/CanvasPanel.js';
import { FileBrowserPanel } from './components/FileBrowserPanel.js';
import { PreviewPanel } from './components/PreviewPanel.js';
import { ApiConsole } from './components/ApiConsole.js';
import { ProvidersPage } from './components/ProvidersPage.js';
import { BudgetPanel } from './components/BudgetPanel.js';
import { PendingQuestions } from './components/PendingQuestions.js';
import { RequirementWizard } from './components/RequirementWizard.js';
import { AuditPanel } from './components/AuditPanel.js';
import { NotificationBell } from './components/NotificationBell.js';
import { connectionLabel } from './viewmodels/live-connection.js';
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

  if (page === 'providers') {
    return (
      <main className="shell">
        <header className="topbar"><div><p className="eyebrow">ww / ORCHESTRATION</p><h1>API sağlayıcıları</h1></div><div className="topbar-actions"><button type="button" onClick={() => setPage('workspace')}>← Çalışma alanı</button></div></header>
        <ProvidersPage />
      </main>
    );
  }

  return (
    <main className="shell">
      <header className="topbar"><div><p className="eyebrow">ww / ORCHESTRATION</p><h1>Agent çalışma alanı</h1></div><div className="topbar-actions"><span className={`conn conn--${connection}`} title="Canlı olay bağlantısı"><span className="conn__dot" aria-hidden="true" />{connectionLabel(connection)}</span><button type="button" onClick={() => setPage('providers')}>API'ler</button><NotificationBell signals={{ budget: budgetReport.budget, providers: providerList, tasks, escalations: auditReport.escalations, recordFindings: auditReport.recordFindings }} /><input aria-label="Proje kimliği" placeholder="Proje UUID" value={projectId} onChange={(event) => setProjectId(event.target.value)} /></div></header>

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
        <div className="command-row"><input id="command" value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Bir sonraki adımı sor…" /><button type="button" onClick={() => void sendCommand()}>Gönder</button></div>
        {messageStatus ? <small>{messageStatus}</small> : null}
      </section>
      {projectId ? <section className="workspace-card">
        <div className="project-controls"><span className={`pill pill--${projectStatus}`}>{projectStatus || 'yükleniyor'}</span><button type="button" onClick={() => void updateProjectStatus(projectStatus === 'paused' ? 'running' : 'paused')}>{projectStatus === 'paused' ? 'Devam et' : 'Duraklat'}</button><button type="button" onClick={() => void updateProjectStatus('archived')}>Arşivle</button></div>
        <RequirementWizard projectId={projectId} /><PendingQuestions projectId={projectId} /><BudgetPanel projectId={projectId} />
        <AuditPanel projectId={projectId} />
        {usage ? <div className="metrics usage-metrics"><div><strong>${usage.costUsd.toFixed(4)}</strong><span>Maliyet</span></div><div><strong>{usage.calls}</strong><span>Çağrı</span></div><div><strong>{usage.promptTokens + usage.completionTokens}</strong><span>Token</span></div></div> : null}
        {providerHealth.length > 0 ? <div className="provider-health" aria-label="Sağlayıcı sağlığı">{providerHealth.map((provider) => <span key={provider.provider_id} className={`provider-badge provider-badge--${provider.health_status}`}><i aria-hidden="true" />{provider.provider_id}: {provider.health_status}</span>)}</div> : null}
        <p className="hint">API sağlayıcıları ve anahtarlar <button type="button" className="linklike" onClick={() => setPage('providers')}>API'ler sayfasında</button> yönetilir.</p>
        {workspaceError === '' ? null : (
          <p className="audit-error" role="alert">{workspaceError}</p>
        )}
        <TabBar tab={tab} onTab={setTab} counts={{ tasks: tasks.length, events: events.length }} />
        {tab === 'tasks' ? <TaskListPanel tasks={tasks} statusCounts={statusCounts} /> : tab === 'timeline' ? <TimelinePanel events={events} cursor={timelineCursor} onCursor={setTimelineCursor} visible={replay.visible} at={replay.at} /> : tab === 'canvas' ? <CanvasPanel projectId={projectId} events={events} cursor={timelineCursor} onCursor={setTimelineCursor} at={replay.at} tasks={tasks} statusByTask={timelineCursor >= events.length ? undefined : replay.statusByTask} selectedAgent={selectedAgent} onSelectAgent={setSelectedAgent} /> : tab === 'files' ? <FileBrowserPanel projectId={projectId} files={files} selectedFile={selectedFile} onSelectFile={setSelectedFile} narratorQuestion={narratorQuestion} onNarratorQuestion={setNarratorQuestion} onAskNarrator={() => void askNarrator()} narratorResult={narratorResult ?? undefined} /> : tab === 'api' ? <ApiConsole projectId={projectId} artifacts={apiArtifacts} /> : <><PreviewPanel projectId={projectId} /><MobilePreviewPanel projectId={projectId} /></>}
      </section> : <ProjectPicker projects={projects} draft={projectDraft} onDraft={(patch) => setProjectDraft((current) => ({ ...current, ...patch }))} onCreate={() => void createProject()} statusMessage={projectStatusMessage} onSelect={setProjectId} loadError={projectsError} />}
    </main>
  );
}
