import type { TaskListViewModel } from '../../viewmodels/useTaskListViewModel.js';

export function TaskListView({
  tasks,
  completedCount,
  onComplete,
}: TaskListViewModel) {
  return (
    <main className="page-shell">
      <header className="hero">
        <p className="eyebrow">ww web starter</p>
        <h1>Build from a clear foundation.</h1>
        <p>
          This sample keeps rendering, state, persistence, and domain behavior
          in separate MVVM layers.
        </p>
      </header>

      <section className="task-card" aria-labelledby="starter-tasks">
        <div className="task-card__header">
          <h2 id="starter-tasks">Starter tasks</h2>
          <span>
            {completedCount}/{tasks.length} complete
          </span>
        </div>

        <ul>
          {tasks.map((task) => (
            <li key={task.id}>
              <span>{task.title}</span>
              <button
                type="button"
                disabled={task.status === 'completed'}
                onClick={() => onComplete(task.id)}
              >
                {task.status === 'completed' ? 'Completed' : 'Mark complete'}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
