import { useState, useMemo } from "react";
import type { Task } from "../services/projects.js";

export type TaskStatusFilter = "all" | "running" | "waiting" | "done" | "failed";

export function useTaskFilterViewModel(tasks: readonly Task[]) {
  const [filter, setFilter] = useState<TaskStatusFilter>("all");
  const [search, setSearch] = useState("");

  const filteredTasks = useMemo(() => {
    let list = [...tasks];

    if (filter !== "all") {
      list = list.filter((t) => {
        if (filter === "running") return t.status === "running" || t.status === "active";
        if (filter === "waiting") return t.status === "waiting_verify" || t.status === "waiting_answer" || t.status === "queued";
        if (filter === "done") return t.status === "done" || t.status === "completed";
        if (filter === "failed") return t.status === "failed" || t.status === "escalated";
        return true;
      });
    }

    if (search.trim()) {
      const q = search.toLowerCase().trim();
      list = list.filter((t) =>
        (t.title && t.title.toLowerCase().includes(q)) ||
        t.task_id.toLowerCase().includes(q)
      );
    }

    return list;
  }, [tasks, filter, search]);

  const counts = useMemo(() => {
    return {
      all: tasks.length,
      running: tasks.filter((t) => t.status === "running" || t.status === "active").length,
      waiting: tasks.filter((t) => t.status === "waiting_verify" || t.status === "waiting_answer" || t.status === "queued").length,
      done: tasks.filter((t) => t.status === "done" || t.status === "completed").length,
      failed: tasks.filter((t) => t.status === "failed" || t.status === "escalated").length,
    };
  }, [tasks]);

  return {
    filter,
    setFilter,
    search,
    setSearch,
    filteredTasks,
    counts,
  };
}
