import type { Project } from "../services/projects.js";
import { projectStatusLabel } from "../services/labels.js";
import { useProjectSwitcherViewModel } from "../viewmodels/useProjectSwitcherViewModel.js";

export function ProjectSwitcher({
  projects,
  selectedProjectId,
  onSelectProject,
  onNewProject,
}: {
  readonly projects: readonly Project[];
  readonly selectedProjectId: string;
  readonly onSelectProject: (projectId: string) => void;
  readonly onNewProject?: (() => void) | undefined;
}) {
  const { open, toggleOpen, close, search, setSearch, selectedProject, filteredProjects } =
    useProjectSwitcherViewModel(projects, selectedProjectId);

  return (
    <div className="project-switcher-container">
      <button
        type="button"
        className="project-switcher-btn"
        onClick={toggleOpen}
        aria-expanded={open}
        aria-label="Proje seçimi"
      >
        <span className="project-type-icon">
          {selectedProject?.type === "mobile" ? "M" : selectedProject?.type === "api" ? "A" : "W"}
        </span>
        <strong>{selectedProject?.name || "Proje Seçin"}</strong>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor">
          <path d="M3 4.5l3 3 3-3" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open ? (
        <div className="project-switcher-popover" role="dialog" aria-label="Proje Değiştirici">
          <input
            type="text"
            className="project-switcher-search"
            placeholder="Proje ara…"
            aria-label="Proje ara"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />

          <p className="project-switcher-section-title">SON PROJELER</p>
          <div className="project-switcher-list">
            {filteredProjects.length === 0 ? (
              <p className="hint">Proje bulunamadı.</p>
            ) : (
              filteredProjects.map((p) => {
                const isSelected = p.project_id === selectedProjectId;
                return (
                  <button
                    key={p.project_id}
                    type="button"
                    className={`project-switcher-item ${isSelected ? "active" : ""}`}
                    onClick={() => {
                      onSelectProject(p.project_id);
                      close();
                    }}
                  >
                    <span className="project-type-icon">
                      {p.type === "mobile" ? "M" : p.type === "api" ? "A" : "W"}
                    </span>
                    <span className="project-item-name">{p.name}</span>
                    <span className="project-item-status">{projectStatusLabel(p.status)}</span>
                  </button>
                );
              })
            )}
          </div>

          {onNewProject ? (
            <button
              type="button"
              className="btn-new-project-inline"
              onClick={() => {
                close();
                onNewProject();
              }}
            >
              + Yeni proje başlat
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
