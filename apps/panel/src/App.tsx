import { useHealth } from './viewmodels/useHealth.js';
import { useEffect, useMemo, useState } from 'react';
import { TaskCanvas } from './components/TaskCanvas.js';
import { FileEditor } from './components/FileEditor.js';

type Task = { task_id: string; title: string; status: string; priority: number; updated_at: string; target_files?: string[] };
type EventItem = { event: string; seq: number; ts: string; data: unknown };
type Project = { project_id: string; name: string; status: string; type: string };
type Usage = { costUsd: number; promptTokens: number; completionTokens: number; calls: number };

const apiBase = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

export default function App() {
  const { health, state, status } = useHealth();
  const [projectId, setProjectId] = useState(() => new URLSearchParams(window.location.search).get('project') ?? '');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [message, setMessage] = useState('');
  const [messageStatus, setMessageStatus] = useState('');
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
      try { setEvents((current) => [...current.slice(-99), JSON.parse(event.data) as EventItem]); } catch { /* malformed frames are ignored */ }
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

  return (
    <main className="shell">
      <header className="topbar"><div><p className="eyebrow">ww / ORCHESTRATION</p><h1>Agent çalışma alanı</h1></div><input aria-label="Proje kimliği" placeholder="Proje UUID" value={projectId} onChange={(event) => setProjectId(event.target.value)} /></header>

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
        <nav className="tabs"><button className={tab === 'tasks' ? 'active' : ''} onClick={() => setTab('tasks')}>Görevler <span>{tasks.length}</span></button><button className={tab === 'canvas' ? 'active' : ''} onClick={() => setTab('canvas')}>Tuval</button><button className={tab === 'files' ? 'active' : ''} onClick={() => setTab('files')}>Dosyalar</button><button className={tab === 'timeline' ? 'active' : ''} onClick={() => setTab('timeline')}>Zaman çizelgesi <span>{events.length}</span></button><button className={tab === 'api' ? 'active' : ''} onClick={() => setTab('api')}>API</button><button className={tab === 'preview' ? 'active' : ''} onClick={() => setTab('preview')}>Önizleme</button></nav>
        {tab === 'tasks' ? <><div className="metrics">{Object.entries(statusCounts).map(([key, count]) => <div key={key}><strong>{count}</strong><span>{key}</span></div>)}</div><ul className="task-list">{tasks.map((task) => <li key={task.task_id}><div><strong>{task.title}</strong><small>{task.task_id}</small></div><span className={`pill pill--${task.status}`}>{task.status}</span></li>)}</ul></> : tab === 'timeline' ? <ol className="timeline">{events.slice().reverse().map((item) => <li key={`${item.seq}-${item.event}`}><time>{new Date(item.ts).toLocaleTimeString()}</time><strong>{item.event}</strong><code>#{item.seq}</code></li>)}</ol> : tab === 'canvas' ? <TaskCanvas tasks={tasks} /> : tab === 'files' ? <div><ul className="file-list">{[...new Set(tasks.flatMap((task) => task.target_files ?? []))].sort().map((file) => <li key={file}><code>{file}</code><small>fihrist / salt-okunur</small></li>)}</ul><FileEditor filePath={[...new Set(tasks.flatMap((task) => task.target_files ?? []))].sort()[0]} summary="Hedef dosya özeti; içerik değişikliği sohbet/executor üzerinden yapılır." /></div> : tab === 'api' ? <div className="api-console"><h3>API test konsolu</h3><p>Çağrı, token ve maliyet özeti.</p><code>GET /projects/{projectId}/usage</code></div> : <div className="preview-frame"><div className="device-bar">Web önizleme · sandbox çıktısı</div><iframe title="Proje önizleme" src={import.meta.env.VITE_PREVIEW_URL ?? 'about:blank'} sandbox="allow-scripts" /></div>}
      </section> : <section className="workspace-card project-picker"><h2>Projeler</h2><p className="hint">Bir proje seçin veya UUID ile doğrudan açın.</p><ul className="task-list">{projects.map((project) => <li key={project.project_id} onClick={() => setProjectId(project.project_id)}><div><strong>{project.name}</strong><small>{project.type} · {project.project_id}</small></div><span className={`pill pill--${project.status}`}>{project.status}</span></li>)}</ul></section>}
    </main>
  );
}
