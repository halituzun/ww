import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import type { Project } from "../services/projects.js";

export function useProjectSwitcherViewModel(projects: readonly Project[], selectedProjectId: string) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedProject = useMemo(
    () => projects.find((p) => p.project_id === selectedProjectId),
    [projects, selectedProjectId]
  );

  const filteredProjects = useMemo(() => {
    if (!search.trim()) return projects;
    const q = search.toLowerCase();
    return projects.filter((p) => p.name.toLowerCase().includes(q) || p.project_id.toLowerCase().includes(q));
  }, [projects, search]);

  const close = useCallback(() => setOpen(false), []);

  const toggleOpen = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      if (next && typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("ww-popover-open", { detail: "project-switcher" }));
      }
      return next;
    });
  }, []);

  // Karşılıklı dışlama ve sayfa değişimi
  useEffect(() => {
    function handleOtherPopover(e: Event) {
      const customEvent = e as CustomEvent<string>;
      if (customEvent.detail !== "project-switcher") {
        close();
      }
    }
    function handleHashChange() {
      close();
    }
    if (typeof window !== "undefined") {
      window.addEventListener("ww-popover-open", handleOtherPopover);
      window.addEventListener("hashchange", handleHashChange);
    }
    return () => {
      if (typeof window !== "undefined") {
        window.removeEventListener("ww-popover-open", handleOtherPopover);
        window.removeEventListener("hashchange", handleHashChange);
      }
    };
  }, [close]);

  // Dışarı tıklama ve Escape
  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        close();
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        close();
      }
    }
    if (typeof window !== "undefined") {
      window.addEventListener("mousedown", handleClickOutside);
      window.addEventListener("keydown", handleKeyDown);
    }
    return () => {
      if (typeof window !== "undefined") {
        window.removeEventListener("mousedown", handleClickOutside);
        window.removeEventListener("keydown", handleKeyDown);
      }
    };
  }, [open, close]);

  return {
    open,
    toggleOpen,
    close,
    search,
    setSearch,
    selectedProject,
    filteredProjects,
    containerRef,
  };
}
