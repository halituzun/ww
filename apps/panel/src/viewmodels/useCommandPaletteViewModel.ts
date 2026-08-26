import { useState, useEffect, useCallback, useMemo } from "react";
import { NAV_ROUTES, type PageId } from "../services/routes.js";
import type { Project } from "../services/projects.js";

export interface PaletteAction {
  readonly id: string;
  readonly category: string;
  readonly title: string;
  readonly shortcut?: string;
  readonly onSelect: () => void;
}

export function useCommandPaletteViewModel({
  onNavigate,
  projects,
  onSelectProject,
  onApprovePlan,
}: {
  readonly onNavigate: (page: PageId) => void;
  readonly projects?: readonly Project[];
  readonly onSelectProject?: (id: string) => void;
  readonly onApprovePlan?: () => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  const openPalette = useCallback(() => setIsOpen(true), []);
  const closePalette = useCallback(() => {
    setIsOpen(false);
    setQuery("");
    setSelectedIndex(0);
  }, []);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setIsOpen((prev) => !prev);
      }
      if (e.key === "Escape" && isOpen) {
        closePalette();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, closePalette]);

  const allActions = useMemo<PaletteAction[]>(() => {
    const list: PaletteAction[] = [];

    // Sayfa gezintisi eylemleri
    NAV_ROUTES.forEach((r) => {
      list.push({
        id: `page-${r.id}`,
        category: "Gezinti",
        title: `Sayfaya Git: ${r.label}`,
        onSelect: () => {
          onNavigate(r.id);
          closePalette();
        },
      });
    });

    // Proje secim eylemleri
    if (projects && onSelectProject) {
      projects.forEach((p) => {
        list.push({
          id: `proj-${p.project_id}`,
          category: "Projeler",
          title: `Projeyi Aç: ${p.name}`,
          onSelect: () => {
            onSelectProject(p.project_id);
            closePalette();
          },
        });
      });
    }

    // Hizli eylemler
    if (onApprovePlan) {
      list.push({
        id: "act-approve-plan",
        category: "Hızlı Eylemler",
        title: "Mevcut Görev Planını Onayla",
        onSelect: () => {
          onApprovePlan();
          closePalette();
        },
      });
    }

    return list;
  }, [onNavigate, projects, onSelectProject, onApprovePlan, closePalette]);

  const filteredActions = useMemo(() => {
    if (!query.trim()) return allActions;
    const q = query.toLowerCase().trim();
    return allActions.filter(
      (a) => a.title.toLowerCase().includes(q) || a.category.toLowerCase().includes(q)
    );
  }, [allActions, query]);

  return {
    isOpen,
    openPalette,
    closePalette,
    query,
    setQuery,
    selectedIndex,
    setSelectedIndex,
    filteredActions,
  };
}
