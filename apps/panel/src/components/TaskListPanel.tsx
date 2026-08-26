import React from "react";
import { taskStatusLabel } from "../services/task-status.js";
import type { Task } from "../services/projects.js";

export function TaskListPanel({
  tasks,
  statusCounts,
  onSelectTask,
}: {
  readonly tasks: readonly Task[];
  readonly statusCounts: Readonly<Record<string, number>>;
  readonly onSelectTask?: ((taskId: string) => void) | undefined;
}) {
  if (tasks.length === 0) {
    return <p className="hint">Bu projede henüz görev yok.</p>;
  }

  return (
    <div className="task-list-panel">
      {Object.keys(statusCounts).length > 0 ? (
        <div className="metrics">
          {Object.entries(statusCounts).map(([key, count]) => (
            <div key={key}>
              <strong>{count}</strong>
              <span>{taskStatusLabel(key)}</span>
            </div>
          ))}
        </div>
      ) : null}

      <ul className="task-list">
        {tasks.map((task) => (
          <li key={task.task_id} className="task-row-container">
            <button
              type="button"
              className="task-row"
              onClick={() => onSelectTask?.(task.task_id)}
              aria-label={`${task.title} görev detayını aç`}
            >
              <div>
                <strong>{task.title}</strong>
                <small>{task.task_id}</small>
              </div>
              <span className={`pill pill--${task.status}`}>{taskStatusLabel(task.status)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
