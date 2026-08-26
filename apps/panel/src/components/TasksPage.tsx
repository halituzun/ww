// TasksPage — Görevler sayfası (SALT GÖRÜNÜM, docs/09 MVVM standardı).
// useTaskFilterViewModel burada kullanılır (ViewModel katmanı); görünüm logic taşımaz.
// TaskFilters + TaskTable: filtresiz düz liste yerine tam tablo görünümü.
// (2026-08-26) TaskListPanel'in yerini aldı; TaskListPanel silindi.
import React from "react";
import { TaskFilters } from "./TaskFilters.js";
import { TaskTable } from "./TaskTable.js";
import { useTaskFilterViewModel } from "../viewmodels/useTaskFilterViewModel.js";
import type { Task } from "../services/projects.js";

export function TasksPage({
  tasks,
  onSelectTask,
}: {
  readonly tasks: readonly Task[];
  readonly onSelectTask?: ((taskId: string) => void) | undefined;
}) {
  const vm = useTaskFilterViewModel(tasks);

  if (tasks.length === 0) {
    return (
      <div className="tasks-page tasks-page--empty">
        <p className="hint">Bu projede henüz görev yok.</p>
      </div>
    );
  }

  return (
    <div className="tasks-page">
      <div className="tasks-page-header">
        <h2 className="tasks-page-title">Görevler</h2>
        <span className="badge badge--neutral">{tasks.length} Görev</span>
      </div>

      <TaskFilters
        filter={vm.filter}
        onFilterChange={vm.setFilter}
        search={vm.search}
        onSearchChange={vm.setSearch}
        counts={vm.counts}
      />

      <TaskTable
        tasks={vm.filteredTasks}
        onSelectTask={onSelectTask}
      />
    </div>
  );
}
