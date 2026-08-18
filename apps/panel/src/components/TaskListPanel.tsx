// Görev listesi — SALT GÖRÜNÜM (docs/08 → görev listesi).
//
// NEDEN AYRI: App.tsx'in 88. satırı 2251 KARAKTERDİ; tüm sekmelerin gövdesi
// tek bir ternary zincirinde duruyordu. Satır sayısı düşmüştü ama monolit yok
// olmamış, sıkışmıştı — okunamaz bir satır, uzun bir dosyadan iyi değildir.
import { taskStatusLabel } from '../services/task-status.js';
import type { Task } from '../services/projects.js';

export function TaskListPanel({ tasks, statusCounts }: {
  readonly tasks: readonly Task[];
  readonly statusCounts: Readonly<Record<string, number>>;
}) {
  // Boş durum AÇIKÇA söylenir (docs/09 ui_audit): boş bir liste kullanıcıya
  // "yükleniyor mu, yok mu?" sorusunu bırakır.
  if (tasks.length === 0) {
    return <p className="hint">Bu projede henüz görev yok.</p>;
  }

  return (
    <>
      <div className="metrics">
        {Object.entries(statusCounts).map(([key, count]) => (
          <div key={key}><strong>{count}</strong><span>{taskStatusLabel(key)}</span></div>
        ))}
      </div>
      <ul className="task-list">
        {tasks.map((task) => (
          <li key={task.task_id}>
            <div><strong>{task.title}</strong><small>{task.task_id}</small></div>
            <span className={`pill pill--${task.status}`}>{taskStatusLabel(task.status)}</span>
          </li>
        ))}
      </ul>
    </>
  );
}
