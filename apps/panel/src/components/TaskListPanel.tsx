import { taskStatusLabel } from "../services/task-status.js";
import type { Task } from "../services/projects.js";

export function TaskListPanel({
  tasks,
  statusCounts,
}: {
  readonly tasks: readonly Task[];
  readonly statusCounts: Readonly<Record<string, number>>;
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
          <li key={task.task_id} className="task-row">
            <div>
              <strong>{task.title}</strong>
              <small>{task.task_id}</small>
            </div>
            <span className={`pill pill--${task.status}`}>{taskStatusLabel(task.status)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
