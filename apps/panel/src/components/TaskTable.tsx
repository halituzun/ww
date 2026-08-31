// TaskTable — SALT GÖRÜNÜM (docs/09 MVVM standardı).
// Tablo satırları erişilebilir: ilk hücrede <button> ile klavye+fare erişimi.
// onSelectTask → TaskDetailDrawer'ı açar (App.tsx üzerinden).
import React from "react";
import { taskStatusLabel } from "../services/task-status.js";
import type { Task } from "../services/projects.js";

export function TaskTable({
  tasks,
  onSelectTask,
}: {
  readonly tasks: readonly Task[];
  readonly onSelectTask?: ((taskId: string) => void) | undefined;
}) {
  if (tasks.length === 0) {
    return (
      <div className="task-table-empty">
        <p className="hint">Filtreye uygun görev bulunamadı.</p>
      </div>
    );
  }

  return (
    <div className="task-table-container">
      <table className="task-table">
        <thead>
          <tr>
            <th>GÖREV &amp; ID</th>
            <th>DURUM</th>
            <th>ÖNCELİK</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => (
            <tr key={task.task_id} className="task-table-row">
              {/* İlk hücrede gerçek <button> — klavye (Tab/Enter/Space) erişilebilir */}
              <td className="task-cell-main">
                <button
                  type="button"
                  className="task-row-btn"
                  onClick={() => onSelectTask?.(task.task_id)}
                  aria-label={`${task.title ?? task.task_id} görev detayını aç`}
                >
                  <strong>{task.title ?? task.task_id}</strong>
                  <small className="mono-id">{task.task_id}</small>
                </button>
              </td>
              <td>
                <span className={`pill pill--${task.status}`}>
                  {taskStatusLabel(task.status)}
                </span>
              </td>
              <td className="mono-priority">{task.priority ?? 0}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
