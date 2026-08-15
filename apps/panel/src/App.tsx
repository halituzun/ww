import { useHealth } from './viewmodels/useHealth.js';
import { useEffect, useMemo, useState } from 'react';
import { TaskCanvas } from './components/TaskCanvas.js';
import { FileEditor } from './components/FileEditor.js';

type Task = { task_id: string; title: string; status: string; priority: number; updated_at: string; target_files?: string[] };
type EventItem = { event: string; seq: number; ts: string; data: unknown };
type Project = { project_id: string; name: string; status: string; type: string };
type Usage = { costUsd: number; promptTokens: number; completionTokens: number; calls: number };
type FileIndex = { file_path: string; summary: string; layer: string; exports: string[]; related_task_ids: string[]; last_commit_hash: string; change_count: number; updated_at: string };
type ProviderHealth = { provider_id: string; health_status: string; last_health_check: string };
type ApiArtifact = { artifact_id: string; name: string; path: string; summary: string; commit_hash: string };

const apiBase = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

export default function App() {
  const { health, state, status } = useHealth();
  const [projectId, setProjectId] = useState(() => new URLSearchParams(window.location.search).get('project') ?? '');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [files, setFiles] = useState<FileIndex[]>([]);
  const [providerHealth, setProviderHealth] = useState<ProviderHealth[]>([]);
  const [apiArtifacts, setApiArtifacts] = useState<ApiArtifact[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | undefined>();
  const [events, setEvents] = useState<EventItem[]>([]);
  const [message, setMessage] = useState('');
  const [messageStatus, setMessageStatus] = useState('');
  const [apiPath, setApiPath] = useState('/health');
  const [apiResponse, setApiResponse] = useState('');
  const [narratorQuestion, setNarratorQuestion] = useState('Bunu nasıl yaptın?');
  const [narratorResult, setNarratorResult] = useState<{ answer: string; evidenceRefs: string[] } | null>(null);
  const [tab, setTab] = useState<'tasks' | 'timeline' | 'canvas' | 'files' | 'api' | 'preview'>('tasks');

  useEffect(() => {
    if (projectId) return;
    void fetch(`${apiBase}/projects`).then((response) => response.ok ? response.json() as Promise<Project[]> : []).then(setProjects).catch(() => setProjects([]));
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    let active = true;
    const load = async () => {
      const response = await fetch(`${apiBase}/projects/${projectId}/tasks`);
      if (active && response.ok) setTasks(await response.json() as Task[]);
      const usageResponse = await fetch(`${apiBase}/projects/${projectId}/usage`);
      if (active && usageResponse.ok) setUsage(await usageResponse.json() as Usage);
      const filesResponse = await fetch(`${apiBase}/projects/${projectId}/files`);
      if (active && filesResponse.ok) {
        const nextFiles = await filesResponse.json() as FileIndex[];
        setFiles(nextFiles);
        setSelectedFile((current) => current && nextFiles.some((file) => file.file_path === current) ? current : nextFiles[0]?.file_path);
      }
      const healthResponse = await fetch(`${apiBase}/projects/${projectId}/provider-health`);
      if (active && healthResponse.ok) setProviderHealth(await healthResponse.json() as ProviderHealth[]);
      const artifactResponse = await fetch(`${apiBase}/projects/${projectId}/artifacts?type=api_endpoint`);
      if (active && artifactResponse.ok) setApiArtifacts(await artifactResponse.json() as ApiArtifact[]);
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
        const next = JSON.parse(event.data) as EventItem;
        setEvents((current) => [...current.slice(-99), next]);
        if (document.visibilityState !== 'visible' && 'Notification' in window && Notification.permission === 'granted') {
          new Notification(`ww · ${next.event}`, { body: 'Proje zaman çizelgesinde yeni bir olay var.' });
        }
      } catch { /* malformed frames are ignored */ }
    };
    return () => socket.close();
  }, [projectId]);

  const statusCounts = useMemo(() => tasks.reduce<Record<string, number>>((counts, task) => ({ ...counts, [task.status]: (counts[task.status] ?? 0) + 1 }), {}), [tasks]);
  const sendCommand = async () => {
    if (!projectId || message.trim() === '') return;
    setMessageStatus('Gönderiliyor…');
    const response = await fetch(`${apiBase}/projects/${projectId}/messages`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${import.meta.env.VITE_SESSION_TOKEN ?? ''}` }, body: JSON.stringify({ kind: 'user_command', text: message }) });
    setMessageStatus(response.ok ? 'Mesaj gönderildi' : 'Mesaj gönderilemedi');
    if (response.ok) setMessage('');
  };
  const runApiRequest = async () => {
    setApiResponse('Çalışıyor…');
    try { const response = await fetch(`${apiBase}${apiPath}`); setApiResponse(`${response.status} ${await response.text()}`); }
    catch { setApiResponse('İstek başarısız'); }
  };
  const askNarrator = async () => {
    if (!projectId || narratorQuestion.trim() === '') return;
    const response = await fetch(`${apiBase}/projects/${projectId}/narrator`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: narratorQuestion }) });
    if (response.ok) setNarratorResult(await response.json() as { answer: string; evidenceRefs: string[] });
  };
  const enableNotifications = async () => {
    if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
  };

  return (
    <main className="shell">
      <header className="topbar"><div><p className="eyebrow">ww / ORCHESTRATION</p><h1>Agent çalışma alanı</h1></div><div className="topbar-actions"><button type="button" onClick={() => void enableNotifications()}>Bildirimleri aç</button><input aria-label="Proje kimliği" placeholder="Proje UUID" value={projectId} onChange={(event) => setProjectId(event.target.value)} /></div></header>

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
        {usage ? <div className="metrics usage-metrics"><div><strong>${usage.costUsd.toFixed(4)}</strong><span>Maliyet</span></div><div><strong>{usage.calls}</strong><span>Çağrı</span></div><div><strong>{usage.promptTokens + usage.completionTokens}</strong><span>Token</span></div></div> : null}
        {providerHealth.length > 0 ? <div className="provider-health" aria-label="Sağlayıcı sağlığı">{providerHealth.map((provider) => <span key={provider.provider_id} className={`provider-badge provider-badge--${provider.health_status}`}><i aria-hidden="true" />{provider.provider_id}: {provider.health_status}</span>)}</div> : null}
        <nav className="tabs"><button className={tab === 'tasks' ? 'active' : ''} onClick={() => setTab('tasks')}>Görevler <span>{tasks.length}</span></button><button className={tab === 'canvas' ? 'active' : ''} onClick={() => setTab('canvas')}>Tuval</button><button className={tab === 'files' ? 'active' : ''} onClick={() => setTab('files')}>Dosyalar</button><button className={tab === 'timeline' ? 'active' : ''} onClick={() => setTab('timeline')}>Zaman çizelgesi <span>{events.length}</span></button><button className={tab === 'api' ? 'active' : ''} onClick={() => setTab('api')}>API</button><button className={tab === 'preview' ? 'active' : ''} onClick={() => setTab('preview')}>Önizleme</button></nav>
        {tab === 'tasks' ? <><div className="metrics">{Object.entries(statusCounts).map(([key, count]) => <div key={key}><strong>{count}</strong><span>{key}</span></div>)}</div><ul className="task-list">{tasks.map((task) => <li key={task.task_id}><div><strong>{task.title}</strong><small>{task.task_id}</small></div><span className={`pill pill--${task.status}`}>{task.status}</span></li>)}</ul></> : tab === 'timeline' ? <ol className="timeline">{events.slice().reverse().map((item) => <li key={`${item.seq}-${item.event}`}><time>{new Date(item.ts).toLocaleTimeString()}</time><strong>{item.event}</strong><code>#{item.seq}</code></li>)}</ol> : tab === 'canvas' ? <TaskCanvas tasks={tasks} /> : tab === 'files' ? <div className="file-browser"><ul className="file-list">{files.map((file) => <li key={file.file_path} className={selectedFile === file.file_path ? 'active' : ''} onClick={() => setSelectedFile(file.file_path)}><code>{file.file_path}</code><small>{file.layer} · {file.change_count} değişiklik</small></li>)}</ul><FileEditor filePath={selectedFile} summary={files.find((file) => file.file_path === selectedFile)?.summary} /><div className="narrator-card"><h3>Nasıl yapıldı?</h3><div className="command-row"><input aria-label="Narrator sorusu" value={narratorQuestion} onChange={(event) => setNarratorQuestion(event.target.value)} /><button type="button" onClick={() => void askNarrator()}>Sor</button></div>{narratorResult ? <><p>{narratorResult.answer}</p><small>{narratorResult.evidenceRefs.length} kanıt kaynağı</small></> : null}</div></div> : tab === 'api' ? <div className="api-console"><h3>API test konsolu</h3>{apiArtifacts.length > 0 ? <label>Uç seçin<select aria-label="API artifact" onChange={(event) => setApiPath(event.target.value)}><option value="/health">/health</option>{apiArtifacts.map((artifact) => <option key={artifact.artifact_id} value={artifact.path}>{artifact.name} · {artifact.path}</option>)}</select></label> : null}<div className="command-row"><input aria-label="API yolu" value={apiPath} onChange={(event) => setApiPath(event.target.value)} /><button type="button" onClick={() => void runApiRequest()}>Çalıştır</button></div><code>GET {apiPath}</code><pre>{apiResponse}</pre></div> : <div className="preview-frame"><div className="device-bar">Web önizleme · sandbox çıktısı</div><iframe title="Proje önizleme" src={import.meta.env.VITE_PREVIEW_URL ?? 'about:blank'} sandbox="allow-scripts" /></div>}
      </section> : <section className="workspace-card project-picker"><h2>Projeler</h2><p className="hint">Bir proje seçin veya UUID ile doğrudan açın.</p><ul className="task-list">{projects.map((project) => <li key={project.project_id} onClick={() => setProjectId(project.project_id)}><div><strong>{project.name}</strong><small>{project.type} · {project.project_id}</small></div><span className={`pill pill--${project.status}`}>{project.status}</span></li>)}</ul></section>}
    </main>
  );
}
