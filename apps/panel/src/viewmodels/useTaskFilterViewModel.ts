// useTaskFilterViewModel — Görevler sayfası filtre + arama VM.
// Kural: task-status.ts'deki RUNNING_TASK_STATUSES ile hizalıdır.
// "running" ve "active" görev durumu DEĞİLDİR (proje durumudur).
// URL sync: filtre ve arama ?filter=running&q=... olarak taşınır; yenilemede korunur.
// (2026-08-26) URL sync eklendi, filtre durumları task-status.ts'e hizalandı.
import { useState, useMemo, useCallback, useEffect } from "react";
import { RUNNING_TASK_STATUSES } from "../services/task-status.js";
import type { Task } from "../services/projects.js";

export type TaskStatusFilter = "all" | "running" | "waiting" | "done" | "failed";

const VALID_FILTERS: ReadonlySet<string> = new Set<TaskStatusFilter>([
  "all", "running", "waiting", "done", "failed",
]);

function readSearchParam(key: string): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get(key) ?? "";
}

function pushSearchParam(filter: TaskStatusFilter, search: string) {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  if (filter === "all") { params.delete("filter"); } else { params.set("filter", filter); }
  if (search.trim() === "") { params.delete("q"); } else { params.set("q", search.trim()); }
  const qs = params.toString();
  window.history.replaceState(
    null, "",
    qs ? `${window.location.pathname}?${qs}${window.location.hash}`
       : `${window.location.pathname}${window.location.hash}`,
  );
}

function matchFilter(task: Task, filter: TaskStatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "running") return RUNNING_TASK_STATUSES.has(task.status);
  if (filter === "waiting") return task.status === "queued" || task.status === "waiting_user";
  if (filter === "done") return task.status === "done";
  if (filter === "failed")
    return task.status === "failed" || task.status === "cancelled" || task.status === "escalated";
  return true;
}

export interface TaskFilterState {
  filter: TaskStatusFilter;
  search: string;
  filteredTasks: readonly Task[];
  counts: {
    all: number; running: number; waiting: number; done: number; failed: number;
  };
  setFilter: (f: TaskStatusFilter) => void;
  setSearch: (s: string) => void;
}

export function useTaskFilterViewModel(tasks: readonly Task[]): TaskFilterState {
  // URL'den ilk değeri oku
  const initialFilter = (): TaskStatusFilter => {
    const v = readSearchParam("filter");
    return VALID_FILTERS.has(v) ? (v as TaskStatusFilter) : "all";
  };

  const [filter, _setFilter] = useState<TaskStatusFilter>(initialFilter);
  const [search, _setSearch] = useState<string>(() => readSearchParam("q"));

  // URL → state senkronu: hash router sayfa değişiminde de çalışır
  useEffect(() => {
    function sync() {
      const f = readSearchParam("filter");
      _setFilter(VALID_FILTERS.has(f) ? (f as TaskStatusFilter) : "all");
      _setSearch(readSearchParam("q"));
    }
    window.addEventListener("popstate", sync);
    return () => { window.removeEventListener("popstate", sync); };
  }, []);

  const setFilter = useCallback((f: TaskStatusFilter) => {
    _setFilter(f);
    _setSearch((s) => { pushSearchParam(f, s); return s; });
  }, []);

  const setSearch = useCallback((s: string) => {
    _setSearch(s);
    _setFilter((f) => { pushSearchParam(f, s); return f; });
  }, []);

  const filteredTasks = useMemo(() => {
    let list = tasks.filter((t) => matchFilter(t, filter));
    if (search.trim()) {
      const q = search.toLowerCase().trim();
      list = list.filter(
        (t) => (t.title && t.title.toLowerCase().includes(q)) || t.task_id.toLowerCase().includes(q),
      );
    }
    return list;
  }, [tasks, filter, search]);

  const counts = useMemo(
    () => ({
      all: tasks.length,
      running: tasks.filter((t) => RUNNING_TASK_STATUSES.has(t.status)).length,
      waiting: tasks.filter((t) => t.status === "queued" || t.status === "waiting_user").length,
      done: tasks.filter((t) => t.status === "done").length,
      failed: tasks.filter(
        (t) => t.status === "failed" || t.status === "cancelled" || t.status === "escalated",
      ).length,
    }),
    [tasks],
  );

  return { filter, search, filteredTasks, counts, setFilter, setSearch };
}
