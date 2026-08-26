import { useState, useMemo } from "react";
import type { Project } from "../services/projects.js";

export function useProjectSwitcherViewModel(projects: readonly Project[], selectedProjectId: string) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const selectedProject = useMemo(
    () => projects.find((p) => p.project_id === selectedProjectId),
    [projects, selectedProjectId]
  );

  const filteredProjects = useMemo(() => {
    if (!search.trim()) return projects;
    const q = search.toLowerCase();
    return projects.filter((p) => p.name.toLowerCase().includes(q) || p.project_id.toLowerCase().includes(q));
  }, [projects, search]);

  const toggleOpen = () => setOpen((prev) => !prev);
  const close = () => setOpen(false);

  return {
    open,
    toggleOpen,
    close,
    search,
    setSearch,
    selectedProject,
    filteredProjects,
  };
}
