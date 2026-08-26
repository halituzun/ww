// Proje seçim ve oluşturma ekranı — SALT GÖRÜNÜM (docs/08 → projeler).
import { projectStatusLabel } from "../services/labels.js";
import type { Project } from "../services/projects.js";

export interface ProjectDraft {
  readonly name: string;
  readonly type: string;
  readonly budget: string;
}

export function ProjectPicker({
  projects, draft, onDraft, onCreate, statusMessage, onSelect, loadError,
  expressPrompt, onExpressPrompt, expressName, onExpressName, onExpressCreate,
}: {
  readonly projects: readonly Project[];
  readonly draft: ProjectDraft;
  readonly onDraft: (patch: Partial<ProjectDraft>) => void;
  readonly onCreate: () => void;
  readonly statusMessage: string;
  readonly loadError?: string | undefined;
  readonly onSelect: (projectId: string) => void;
  readonly expressPrompt?: string | undefined;
  readonly onExpressPrompt?: ((prompt: string) => void) | undefined;
  readonly expressName?: string | undefined;
  readonly onExpressName?: ((name: string) => void) | undefined;
  readonly onExpressCreate?: (() => void) | undefined;
}) {
  return (
    <section className="workspace-card project-picker">
      <div className="section-header">
        <h2>Projeler</h2>
        <span className="badge badge--neutral">{projects.length} Proje</span>
      </div>

      {onExpressCreate && onExpressPrompt ? (
        <div className="express-create">
          <div className="express-create__head">
            <span className="express-badge">⚡ HIZLI BAŞLAT</span>
            <h3>Tek Cümleyle Hızlı Başlat (Express Modu)</h3>
          </div>
          <p className="hint">Ne tür bir uygulama istediğinizi tek cümleyle yazın, sistem gereksinimleri ve planı anında hazırlasın.</p>
          <div className="express-create__row">
            <input
              aria-label="Uygulama açıklaması"
              className="express-input express-input--prompt"
              placeholder="Örn: Modern karanlık temalı bir yapılacaklar (Todo) listesi web uygulaması"
              value={expressPrompt ?? ""}
              onChange={(event) => onExpressPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && expressPrompt && expressPrompt.trim() !== "") {
                  onExpressCreate();
                }
              }}
            />
            <input
              aria-label="Proje adı (isteğe bağlı)"
              className="express-input express-input--name"
              placeholder="Proje adı (isteğe bağlı)"
              value={expressName ?? ""}
              onChange={(event) => onExpressName ? onExpressName(event.target.value) : undefined}
              onKeyDown={(event) => {
                if (event.key === "Enter" && expressPrompt && expressPrompt.trim() !== "") {
                  onExpressCreate();
                }
              }}
            />
            <button
              type="button"
              className="btn btn--primary btn--express"
              onClick={onExpressCreate}
              disabled={!expressPrompt || expressPrompt.trim() === ""}
            >
              Hızlı Başlat
            </button>
          </div>
        </div>
      ) : null}

      <p className="hint">Veya standart ayarlarla proje oluştur / mevcut bir projeyi seç:</p>

      <div className="project-create">
        <input
          aria-label="Proje adı"
          placeholder="Örn. Takım görev uygulaması"
          value={draft.name}
          onChange={(event) => onDraft({ name: event.target.value })}
        />
        <select
          aria-label="Proje türü"
          value={draft.type}
          onChange={(event) => onDraft({ type: event.target.value })}
        >
          <option value="web">Web</option>
          <option value="api">API</option>
          <option value="mobile">Mobil</option>
        </select>
        <input
          aria-label="Proje bütçesi"
          type="number"
          min="0"
          value={draft.budget}
          onChange={(event) => onDraft({ budget: event.target.value })}
        />
        <button type="button" className="btn btn--secondary" onClick={onCreate}>Proje oluştur</button>
      </div>

      {statusMessage === "" ? null : <small className="hint hint--status">{statusMessage}</small>}

      {loadError !== undefined && loadError !== "" ? (
        <p className="audit-error" role="alert">{loadError}</p>
      ) : projects.length === 0 ? (
        <p className="hint">Henüz proje yok — yukarıdan ilkini oluşturun.</p>
      ) : (
        <ul className="task-list project-list">
          {projects.map((project) => (
            <li key={project.project_id} className="project-item-container">
              <button
                type="button"
                className="project-item"
                onClick={() => onSelect(project.project_id)}
                aria-label={`${project.name} projesini aç`}
              >
                <div className="project-item__info">
                  <strong>{project.name}</strong>
                  <small>{project.type} · {project.project_id}</small>
                </div>
                <span className={`pill pill--${project.status}`}>{projectStatusLabel(project.status)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
