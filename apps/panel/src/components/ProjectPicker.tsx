// Proje seçim ve oluşturma ekranı — SALT GÖRÜNÜM (docs/08 → projeler).
//
// NEDEN AYRI: App.tsx'te 1337 karakterlik tek satırdı; içinde üç form alanı,
// bir buton, bir durum mesajı ve proje listesi vardı. Okunamaz bir satır,
// uzun bir dosyadan iyi değildir.
import type { Project } from '../services/projects.js';

export interface ProjectDraft {
  readonly name: string;
  readonly type: string;
  readonly budget: string;
}

export function ProjectPicker({
  projects, draft, onDraft, onCreate, statusMessage, onSelect, loadError,
}: {
  readonly projects: readonly Project[];
  readonly draft: ProjectDraft;
  /** Yalnız DEĞİŞEN alan bildirilir; birleştirme çağıranın işidir. */
  readonly onDraft: (patch: Partial<ProjectDraft>) => void;
  readonly onCreate: () => void;
  readonly statusMessage: string;
  /** Liste ALINAMADI. Boş listeden ayrı tutulur: ikisini karıştırmak
   * kullanıcıya projelerini kaybettiğini düşündürür. */
  readonly loadError?: string | undefined;
  readonly onSelect: (projectId: string) => void;
}) {
  return (
    <section className="workspace-card project-picker">
      <h2>Projeler</h2>
      <p className="hint">Yeni proje oluştur veya mevcut bir projeyi seç.</p>

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
        <button type="button" onClick={onCreate}>Proje oluştur</button>
      </div>

      {statusMessage === '' ? null : <small className="hint">{statusMessage}</small>}

      {/* Boş durum AÇIKÇA söylenir (docs/09 ui_audit): boş liste kullanıcıya
          "yükleniyor mu, yok mu?" sorusunu bırakır. */}
      {loadError !== undefined && loadError !== '' ? (
        <p className="audit-error" role="alert">{loadError}</p>
      ) : projects.length === 0 ? (
        <p className="hint">Henüz proje yok — yukarıdan ilkini oluşturun.</p>
      ) : (
        <ul className="task-list">
          {projects.map((project) => (
            <li key={project.project_id} onClick={() => onSelect(project.project_id)}>
              <div>
                <strong>{project.name}</strong>
                <small>{project.type} · {project.project_id}</small>
              </div>
              <span className={`pill pill--${project.status}`}>{project.status}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
