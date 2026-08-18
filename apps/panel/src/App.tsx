// Çalışma alanı ekranı — SALT GÖRÜNÜM (docs/09 MVVM).
//
// Durum, veri yükleme, yoklama, canlı bağlantı ve eylemler
// `useWorkspaceViewModel` içindedir; burada iş mantığı bulunmaz.
import { useHealth } from './viewmodels/useHealth.js';
import { TaskCanvas } from './components/TaskCanvas.js';
import { AgentCanvas } from './components/AgentCanvas.js';
import { AgentDetail } from './components/AgentDetail.js';
import { FileEditor } from './components/FileEditor.js';
import { FileFihrist } from './components/FileFihrist.js';
import { TimelineScrubber } from './components/TimelineScrubber.js';
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
    tasks, projects, projectDraft, setProjectDraft,
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
        <nav className="tabs"><button className={tab === 'tasks' ? 'active' : ''} onClick={() => setTab('tasks')}>Görevler <span>{tasks.length}</span></button><button className={tab === 'canvas' ? 'active' : ''} onClick={() => setTab('canvas')}>Tuval</button><button className={tab === 'files' ? 'active' : ''} onClick={() => setTab('files')}>Dosyalar</button><button className={tab === 'timeline' ? 'active' : ''} onClick={() => setTab('timeline')}>Zaman çizelgesi <span>{events.length}</span></button><button className={tab === 'api' ? 'active' : ''} onClick={() => setTab('api')}>API</button><button className={tab === 'preview' ? 'active' : ''} onClick={() => setTab('preview')}>Önizleme</button></nav>
        {tab === 'tasks' ? <><div className="metrics">{Object.entries(statusCounts).map(([key, count]) => <div key={key}><strong>{count}</strong><span>{key}</span></div>)}</div><ul className="task-list">{tasks.map((task) => <li key={task.task_id}><div><strong>{task.title}</strong><small>{task.task_id}</small></div><span className={`pill pill--${task.status}`}>{task.status}</span></li>)}</ul></> : tab === 'timeline' ? <><TimelineScrubber events={events} cursor={timelineCursor} onCursor={setTimelineCursor} at={replay.at} /><ol className="timeline">{replay.visible.slice().reverse().map((item) => <li key={`${item.cursor}-${item.event}`}><time>{new Date(item.ts).toLocaleTimeString()}</time><strong>{item.event}</strong><code>#{item.cursor}</code></li>)}</ol></> : tab === 'canvas' ? <><TimelineScrubber events={events} cursor={timelineCursor} onCursor={setTimelineCursor} at={replay.at} /><AgentCanvas projectId={projectId} onSelectAgent={setSelectedAgent} /><AgentDetail projectId={projectId} agentId={selectedAgent} /><TaskCanvas tasks={tasks} statusByTask={timelineCursor >= events.length ? undefined : replay.statusByTask} /></> : tab === 'files' ? <div className="file-browser"><ul className="file-list">{files.map((file) => <li key={file.file_path} className={selectedFile === file.file_path ? 'active' : ''} onClick={() => setSelectedFile(file.file_path)}><code>{file.file_path}</code><small>{file.layer} · {file.change_count} değişiklik</small></li>)}</ul><FileEditor projectId={projectId} filePath={selectedFile} summary={files.find((file) => file.file_path === selectedFile)?.summary} /><FileFihrist projectId={projectId} file={files.find((file) => file.file_path === selectedFile)} /><div className="narrator-card"><h3>Nasıl yapıldı?</h3><div className="command-row"><input aria-label="Narrator sorusu" value={narratorQuestion} onChange={(event) => setNarratorQuestion(event.target.value)} /><button type="button" onClick={() => void askNarrator()}>Sor</button></div>{narratorResult ? <><p>{narratorResult.answer}</p><small>{narratorResult.evidenceRefs.length} kanıt kaynağı</small></> : null}</div></div> : tab === 'api' ? <ApiConsole projectId={projectId} artifacts={apiArtifacts} /> : <PreviewPanel projectId={projectId} />}
      </section> : <section className="workspace-card project-picker"><h2>Projeler</h2><p className="hint">Yeni proje oluştur veya mevcut bir projeyi seç.</p><div className="project-create"><input aria-label="Proje adı" placeholder="Örn. Takım görev uygulaması" value={projectDraft.name} onChange={(event) => setProjectDraft((current) => ({ ...current, name: event.target.value }))} /><select aria-label="Proje türü" value={projectDraft.type} onChange={(event) => setProjectDraft((current) => ({ ...current, type: event.target.value }))}><option value="web">Web</option><option value="api">API</option><option value="mobile">Mobil</option></select><input aria-label="Proje bütçesi" type="number" min="0" value={projectDraft.budget} onChange={(event) => setProjectDraft((current) => ({ ...current, budget: event.target.value }))} /><button type="button" onClick={() => void createProject()}>Proje oluştur</button></div>{projectStatusMessage ? <small className="hint">{projectStatusMessage}</small> : null}<ul className="task-list">{projects.map((project) => <li key={project.project_id} onClick={() => setProjectId(project.project_id)}><div><strong>{project.name}</strong><small>{project.type} · {project.project_id}</small></div><span className={`pill pill--${project.status}`}>{project.status}</span></li>)}</ul></section>}
    </main>
  );
}
