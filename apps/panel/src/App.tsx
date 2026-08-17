import { useHealth } from './viewmodels/useHealth.js';
import { useEffect, useMemo, useState } from 'react';
import { TaskCanvas } from './components/TaskCanvas.js';
import { FileEditor } from './components/FileEditor.js';
import { ProvidersPage } from './components/ProvidersPage.js';
import { BudgetPanel } from './components/BudgetPanel.js';
import { AuditPanel } from './components/AuditPanel.js';
import { NotificationBell } from './components/NotificationBell.js';
import { fetchBudgetReport, EMPTY_BUDGET_REPORT, type BudgetReport } from './services/budget.js';
import { fetchAuditReport, EMPTY_AUDIT_REPORT, type AuditReport } from './services/audit.js';
import { fetchProviders, type Provider } from './services/providers.js';
import {
  appendTimelineEvent, countTaskStatuses, pickSelectedFile, type TimelineEvent,
} from './viewmodels/workspace-logic.js';
import {
  askNarrator as askNarratorService,
  createProject as createProjectService,
  fetchApiArtifacts, fetchFiles, fetchProject, fetchProjects, fetchProviderHealth,
  fetchTasks, fetchUsage, sendUserCommand,
  updateProjectStatus as updateProjectStatusService,
  type ApiArtifact, type FileIndex, type Project, type ProviderHealth, type Task, type Usage,
} from './services/projects.js';


const apiBase = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

export default function App() {
  const { health, state, status } = useHealth();
  const [page, setPage] = useState<'workspace' | 'providers'>(() => new URLSearchParams(window.location.search).get('page') === 'providers' ? 'providers' : 'workspace');
  const [budgetReport, setBudgetReport] = useState<BudgetReport>(EMPTY_BUDGET_REPORT);
  const [auditReport, setAuditReport] = useState<AuditReport>(EMPTY_AUDIT_REPORT);
  const [providerList, setProviderList] = useState<Provider[]>([]);
  const [projectId, setProjectId] = useState(() => new URLSearchParams(window.location.search).get('project') ?? '');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectDraft, setProjectDraft] = useState({ name: '', type: 'web', budget: '10' });
  const [projectStatusMessage, setProjectStatusMessage] = useState('');
  const [projectStatus, setProjectStatus] = useState<string>('');
  const [usage, setUsage] = useState<Usage | null>(null);
  const [files, setFiles] = useState<FileIndex[]>([]);
  const [providerHealth, setProviderHealth] = useState<ProviderHealth[]>([]);
  const [apiArtifacts, setApiArtifacts] = useState<ApiArtifact[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | undefined>();
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [message, setMessage] = useState('');
  const [messageStatus, setMessageStatus] = useState('');
  const [apiPath, setApiPath] = useState('/health');
  const [apiResponse, setApiResponse] = useState('');
  const [narratorQuestion, setNarratorQuestion] = useState('Bunu nasıl yaptın?');
  const [narratorResult, setNarratorResult] = useState<{ answer: string; evidenceRefs: string[] } | null>(null);
  const [tab, setTab] = useState<'tasks' | 'timeline' | 'canvas' | 'files' | 'api' | 'preview'>('tasks');

  useEffect(() => {
    if (projectId) return;
    void fetchProjects().then(setProjects);
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    let active = true;
    const load = async () => {
      const [project, nextTasks, nextUsage, nextFiles, health, artifacts] = await Promise.all([
        fetchProject(projectId), fetchTasks(projectId), fetchUsage(projectId),
        fetchFiles(projectId), fetchProviderHealth(projectId), fetchApiArtifacts(projectId),
      ]);
      if (!active) return;
      if (project) setProjectStatus(project.status);
      setTasks(nextTasks);
      setUsage(nextUsage);
      setFiles(nextFiles);
      setSelectedFile((current) => pickSelectedFile(current, nextFiles));
      setProviderHealth(health);
      setApiArtifacts(artifacts);
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, 2_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [projectId]);

  useEffect(() => {
    if (!projectId || typeof WebSocket === 'undefined') return;
    const socket = new WebSocket(`${apiBase.replace(/^http/, 'ws')}/events`);
    socket.onopen = () => socket.send(JSON.stringify({ event: 'subscribe', data: { projectId, afterSeq: 0 } }));
    socket.onmessage = (event) => {
      try {
        const next = JSON.parse(event.data) as TimelineEvent;
        setEvents((current) => appendTimelineEvent(current, next));
      } catch { /* malformed frames are ignored */ }
    };
    return () => socket.close();
  }, [projectId]);

  // docs/08 bildirim kaynakları: bütçe, sağlayıcı sağlığı, bekleyen soru, tırmandırma.
  useEffect(() => {
    let active = true;
    const load = () => {
      void fetchProviders().then((next) => { if (active) setProviderList(next); });
      if (!projectId) return;
      void fetchBudgetReport(projectId).then((next) => { if (active) setBudgetReport(next); });
      void fetchAuditReport(projectId).then((next) => { if (active) setAuditReport(next); });
    };
    load();
    const timer = window.setInterval(load, 15_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [projectId]);

  const statusCounts = useMemo(() => countTaskStatuses(tasks), [tasks]);
  const sendCommand = async () => {
    if (!projectId || message.trim() === '') return;
    setMessageStatus('Gönderiliyor…');
    try {
      await sendUserCommand(projectId, message);
      setMessage('');
      setMessageStatus('Mesaj gönderildi');
    } catch (reason) {
      setMessageStatus(reason instanceof Error ? reason.message : 'Mesaj gönderilemedi');
    }
  };
  const runApiRequest = async () => {
    setApiResponse('Çalışıyor…');
    try { const response = await fetch(`${apiBase}${apiPath}`); setApiResponse(`${response.status} ${await response.text()}`); }
    catch { setApiResponse('İstek başarısız'); }
  };
  const askNarrator = async () => {
    if (!projectId || narratorQuestion.trim() === '') return;
    try {
      setNarratorResult(await askNarratorService(projectId, narratorQuestion));
    } catch {
      setNarratorResult(null);
    }
  };
  const updateProjectStatus = async (status: 'paused' | 'running' | 'archived') => {
    try {
      await updateProjectStatusService(projectId, status);
      setProjectStatus(status);
    } catch (reason) {
      setProjectStatusMessage(reason instanceof Error ? reason.message : 'Durum değiştirilemedi');
    }
  };
  const createProject = async () => {
    try {
      const project = await createProjectService({
        name: projectDraft.name, type: projectDraft.type, budgetUsd: projectDraft.budget,
      });
      setProjects((current) => [...current, project]);
      setProjectId(project.project_id);
      setProjectStatusMessage('Proje oluşturuldu.');
    } catch (reason) {
      setProjectStatusMessage(reason instanceof Error ? reason.message : 'Proje oluşturulamadı');
    }
  };

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
      <header className="topbar"><div><p className="eyebrow">ww / ORCHESTRATION</p><h1>Agent çalışma alanı</h1></div><div className="topbar-actions"><button type="button" onClick={() => setPage('providers')}>API'ler</button><NotificationBell signals={{ budget: budgetReport.budget, providers: providerList, tasks, escalations: auditReport.escalations }} /><input aria-label="Proje kimliği" placeholder="Proje UUID" value={projectId} onChange={(event) => setProjectId(event.target.value)} /></div></header>

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
        <BudgetPanel projectId={projectId} />
        <AuditPanel projectId={projectId} />
        {usage ? <div className="metrics usage-metrics"><div><strong>${usage.costUsd.toFixed(4)}</strong><span>Maliyet</span></div><div><strong>{usage.calls}</strong><span>Çağrı</span></div><div><strong>{usage.promptTokens + usage.completionTokens}</strong><span>Token</span></div></div> : null}
        {providerHealth.length > 0 ? <div className="provider-health" aria-label="Sağlayıcı sağlığı">{providerHealth.map((provider) => <span key={provider.provider_id} className={`provider-badge provider-badge--${provider.health_status}`}><i aria-hidden="true" />{provider.provider_id}: {provider.health_status}</span>)}</div> : null}
        <p className="hint">API sağlayıcıları ve anahtarlar <button type="button" className="linklike" onClick={() => setPage('providers')}>API'ler sayfasında</button> yönetilir.</p>
        <nav className="tabs"><button className={tab === 'tasks' ? 'active' : ''} onClick={() => setTab('tasks')}>Görevler <span>{tasks.length}</span></button><button className={tab === 'canvas' ? 'active' : ''} onClick={() => setTab('canvas')}>Tuval</button><button className={tab === 'files' ? 'active' : ''} onClick={() => setTab('files')}>Dosyalar</button><button className={tab === 'timeline' ? 'active' : ''} onClick={() => setTab('timeline')}>Zaman çizelgesi <span>{events.length}</span></button><button className={tab === 'api' ? 'active' : ''} onClick={() => setTab('api')}>API</button><button className={tab === 'preview' ? 'active' : ''} onClick={() => setTab('preview')}>Önizleme</button></nav>
        {tab === 'tasks' ? <><div className="metrics">{Object.entries(statusCounts).map(([key, count]) => <div key={key}><strong>{count}</strong><span>{key}</span></div>)}</div><ul className="task-list">{tasks.map((task) => <li key={task.task_id}><div><strong>{task.title}</strong><small>{task.task_id}</small></div><span className={`pill pill--${task.status}`}>{task.status}</span></li>)}</ul></> : tab === 'timeline' ? <ol className="timeline">{events.slice().reverse().map((item) => <li key={`${item.seq}-${item.event}`}><time>{new Date(item.ts).toLocaleTimeString()}</time><strong>{item.event}</strong><code>#{item.seq}</code></li>)}</ol> : tab === 'canvas' ? <TaskCanvas tasks={tasks} /> : tab === 'files' ? <div className="file-browser"><ul className="file-list">{files.map((file) => <li key={file.file_path} className={selectedFile === file.file_path ? 'active' : ''} onClick={() => setSelectedFile(file.file_path)}><code>{file.file_path}</code><small>{file.layer} · {file.change_count} değişiklik</small></li>)}</ul><FileEditor filePath={selectedFile} summary={files.find((file) => file.file_path === selectedFile)?.summary} /><div className="narrator-card"><h3>Nasıl yapıldı?</h3><div className="command-row"><input aria-label="Narrator sorusu" value={narratorQuestion} onChange={(event) => setNarratorQuestion(event.target.value)} /><button type="button" onClick={() => void askNarrator()}>Sor</button></div>{narratorResult ? <><p>{narratorResult.answer}</p><small>{narratorResult.evidenceRefs.length} kanıt kaynağı</small></> : null}</div></div> : tab === 'api' ? <div className="api-console"><h3>API test konsolu</h3>{apiArtifacts.length > 0 ? <label>Uç seçin<select aria-label="API artifact" onChange={(event) => setApiPath(event.target.value)}><option value="/health">/health</option>{apiArtifacts.map((artifact) => <option key={artifact.artifact_id} value={artifact.path}>{artifact.name} · {artifact.path}</option>)}</select></label> : null}<div className="command-row"><input aria-label="API yolu" value={apiPath} onChange={(event) => setApiPath(event.target.value)} /><button type="button" onClick={() => void runApiRequest()}>Çalıştır</button></div><code>GET {apiPath}</code><pre>{apiResponse}</pre></div> : <div className="preview-frame"><div className="device-bar">Web önizleme · sandbox çıktısı</div><iframe title="Proje önizleme" src={import.meta.env.VITE_PREVIEW_URL ?? 'about:blank'} sandbox="allow-scripts" /></div>}
      </section> : <section className="workspace-card project-picker"><h2>Projeler</h2><p className="hint">Yeni proje oluştur veya mevcut bir projeyi seç.</p><div className="project-create"><input aria-label="Proje adı" placeholder="Örn. Takım görev uygulaması" value={projectDraft.name} onChange={(event) => setProjectDraft((current) => ({ ...current, name: event.target.value }))} /><select aria-label="Proje türü" value={projectDraft.type} onChange={(event) => setProjectDraft((current) => ({ ...current, type: event.target.value }))}><option value="web">Web</option><option value="api">API</option><option value="mobile">Mobil</option></select><input aria-label="Proje bütçesi" type="number" min="0" value={projectDraft.budget} onChange={(event) => setProjectDraft((current) => ({ ...current, budget: event.target.value }))} /><button type="button" onClick={() => void createProject()}>Proje oluştur</button></div>{projectStatusMessage ? <small className="hint">{projectStatusMessage}</small> : null}<ul className="task-list">{projects.map((project) => <li key={project.project_id} onClick={() => setProjectId(project.project_id)}><div><strong>{project.name}</strong><small>{project.type} · {project.project_id}</small></div><span className={`pill pill--${project.status}`}>{project.status}</span></li>)}</ul></section>}
    </main>
  );
}
