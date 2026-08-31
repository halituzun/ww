import type { TaskStatusFilter } from "../viewmodels/useTaskFilterViewModel.js";

export function TaskFilters({
  filter,
  onFilterChange,
  search,
  onSearchChange,
  counts,
}: {
  readonly filter: TaskStatusFilter;
  readonly onFilterChange: (f: TaskStatusFilter) => void;
  readonly search: string;
  readonly onSearchChange: (s: string) => void;
  readonly counts: {
    readonly all: number;
    readonly running: number;
    readonly waiting: number;
    readonly done: number;
    readonly failed: number;
  };
}) {
  const tabs: Array<{ id: TaskStatusFilter; label: string; count: number }> = [
    { id: "all", label: "Tümü", count: counts.all },
    { id: "running", label: "Çalışıyor", count: counts.running },
    { id: "waiting", label: "Bekliyor", count: counts.waiting },
    { id: "done", label: "Bitti", count: counts.done },
    { id: "failed", label: "Düştü", count: counts.failed },
  ];

  return (
    <div className="task-filters-row">
      <div className="task-filter-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`task-filter-tab ${filter === tab.id ? "active" : ""}`}
            onClick={() => onFilterChange(tab.id)}
          >
            <span>{tab.label}</span>
            <span className="filter-count-badge">{tab.count}</span>
          </button>
        ))}
      </div>
      <div className="task-filter-search">
        <input
          type="text"
          aria-label="Görev ara" placeholder="Görev veya agent ara…"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
        />
      </div>
    </div>
  );
}
