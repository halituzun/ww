// useTaskFilterViewModel — Görevler sayfası filtre + arama VM.
// Kural: task-status.ts'deki RUNNING_TASK_STATUSES ile hizalıdır.
// URL sync: filtre ve arama hash query param (#/tasks?filter=running&q=...) olarak taşınır.
// Tek state objesi {filter, search} — yan-etki okuma anti-pattern'i olmadan çalışır.
import { useState, useMemo, useCallback, useEffect } from "react";
import { RUNNING_TASK_STATUSES } from "../services/task-status.js";
import type { Task } from "../services/projects.js";

export type TaskStatusFilter = "all" | "running" | "waiting" | "done" | "failed";

const VALID_FILTERS: ReadonlySet<string> = new Set<TaskStatusFilter>([
  "all", "running", "waiting", "done", "failed",
]);

interface FilterState {
  filter: TaskStatusFilter;
  search: string;
}

function getQueryParams(): URLSearchParams {
  if (typeof window === "undefined") return new URLSearchParams();
  const hash = window.location.hash || "";
  const qIndex = hash.indexOf("?");
  if (qIndex !== -1) {
    return new URLSearchParams(hash.slice(qIndex + 1));
  }
  return new URLSearchParams(window.location.search);
}

function readUrlState(): FilterState {
  if (typeof window === "undefined") return { filter: "all", search: "" };
  const params = getQueryParams();
  const f = params.get("filter") ?? "all";
  return {
    filter: VALID_FILTERS.has(f) ? (f as TaskStatusFilter) : "all",
    search: params.get("q") ?? "",
  };
}

function pushUrlState(filter: TaskStatusFilter, search: string) {
  if (typeof window === "undefined") return;
  const hash = window.location.hash || "";
  const [pathPart] = hash.split("?");
  const baseRoute = pathPart && pathPart !== "" ? pathPart : "#/tasks";

  const params = new URLSearchParams();
  if (filter !== "all") {
    params.set("filter", filter);
  }
  if (search.trim() !== "") {
    params.set("q", search.trim());
  }

  const qs = params.toString();
  const newHash = qs ? `${baseRoute}?${qs}` : baseRoute;
  if (window.location.hash !== newHash) {
    window.history.replaceState(null, "", `${window.location.pathname}${newHash}`);
  }
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
  const [state, setState] = useState<FilterState>(readUrlState);

  useEffect(() => {
    function onPopOrHash() {
      setState(readUrlState());
    }
    window.addEventListener("popstate", onPopOrHash);
    window.addEventListener("hashchange", onPopOrHash);
    return () => {
      window.removeEventListener("popstate", onPopOrHash);
      window.removeEventListener("hashchange", onPopOrHash);
    };
  }, []);

  const setFilter = useCallback((filter: TaskStatusFilter) => {
    setState((prev) => {
      pushUrlState(filter, prev.search);
      return { ...prev, filter };
    });
  }, []);

  const setSearch = useCallback((search: string) => {
    setState((prev) => {
      pushUrlState(prev.filter, search);
      return { ...prev, search };
    });
  }, []);

  const filteredTasks = useMemo(() => {
    let list = tasks.filter((t) => matchFilter(t, state.filter));
    if (state.search.trim()) {
      const q = state.search.toLowerCase().trim();
      list = list.filter(
        (t) =>
          (t.title && t.title.toLowerCase().includes(q)) ||
          t.task_id.toLowerCase().includes(q),
      );
    }
    return list;
  }, [tasks, state.filter, state.search]);

  const counts = useMemo(
    () => ({
      all: tasks.length,
      running: tasks.filter((t) => RUNNING_TASK_STATUSES.has(t.status)).length,
      waiting: tasks.filter((t) => t.status === "queued" || t.status === "waiting_user").length,
      done: tasks.filter((t) => t.status === "done").length,
      failed: tasks.filter(
        (t) =>
          t.status === "failed" ||
          t.status === "cancelled" ||
          t.status === "escalated",
      ).length,
    }),
    [tasks],
  );

  return { filter: state.filter, search: state.search, filteredTasks, counts, setFilter, setSearch };
}
