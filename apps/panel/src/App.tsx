import { useHealth } from './viewmodels/useHealth.js';
import { useEffect, useMemo, useState } from 'react';

type Task = { task_id: string; title: string; status: string; priority: number; updated_at: string };
type EventItem = { event: string; seq: number; ts: string; data: unknown };

const apiBase = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

export default function App() {
  const { health, state, status } = useHealth();
  const [projectId, setProjectId] = useState(() => new URLSearchParams(window.location.search).get('project') ?? '');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [message, setMessage] = useState('');
  const [messageStatus, setMessageStatus] = useState('');
  const [tab, setTab] = useState<'tasks' | 'timeline'>('tasks');

  useEffect(() => {
    if (!projectId) return;
    let active = true;
    const load = async () => {
      const response = await fetch(`${apiBase}/projects/${projectId}/tasks`);
      if (active && response.ok) setTasks(await response.json() as Task[]);
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
        <nav className="tabs"><button className={tab === 'tasks' ? 'active' : ''} onClick={() => setTab('tasks')}>Görevler <span>{tasks.length}</span></button><button className={tab === 'timeline' ? 'active' : ''} onClick={() => setTab('timeline')}>Canlı zaman çizelgesi <span>{events.length}</span></button></nav>
        {tab === 'tasks' ? <><div className="metrics">{Object.entries(statusCounts).map(([key, count]) => <div key={key}><strong>{count}</strong><span>{key}</span></div>)}</div><ul className="task-list">{tasks.map((task) => <li key={task.task_id}><div><strong>{task.title}</strong><small>{task.task_id}</small></div><span className={`pill pill--${task.status}`}>{task.status}</span></li>)}</ul></> : <ol className="timeline">{events.slice().reverse().map((item) => <li key={`${item.seq}-${item.event}`}><time>{new Date(item.ts).toLocaleTimeString()}</time><strong>{item.event}</strong><code>#{item.seq}</code></li>)}</ol>}
      </section> : <p className="hint">Görevleri ve canlı olayları görmek için bir proje UUID girin.</p>}
    </main>
  );
}
