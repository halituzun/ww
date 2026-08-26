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
    return <p className="hint">Filtreye uygun görev bulunamadı.</p>;
  }

  return (
    <div className="task-table-container">
      <table className="task-table">
        <thead>
          <tr>
            <th>GÖREV & ID</th>
            <th>DURUM</th>
            <th>ÖNCELİK</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => (
            <tr
              key={task.task_id}
              onClick={() => onSelectTask?.(task.task_id)}
              className="task-row"
            >
              <td className="task-cell-main">
                <strong>{task.title || task.task_id}</strong>
                <small className="mono-id">{task.task_id}</small>
              </td>
              <td>
                <span className={`pill pill--${task.status}`}>{taskStatusLabel(task.status)}</span>
              </td>
              <td className="mono-priority">{task.priority ?? 0}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
