// Proje seçim ve oluşturma ekranı — SALT GÖRÜNÜM (docs/08 → projeler).
//
// NEDEN AYRI: App.tsx'te 1337 karakterlik tek satırdı; içinde üç form alanı,
// bir buton, bir durum mesajı ve proje listesi vardı. Okunamaz bir satır,
// uzun bir dosyadan iyi değildir.
import { projectStatusLabel } from '../services/labels.js';
import type { Project } from '../services/projects.js';

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
  /** Yalnız DEĞİŞEN alan bildirilir; birleştirme çağıranın işidir. */
  readonly onDraft: (patch: Partial<ProjectDraft>) => void;
  readonly onCreate: () => void;
  readonly statusMessage: string;
  /** Liste ALINAMADI. Boş listeden ayrı tutulur: ikisini karıştırmak
   * kullanıcıya projelerini kaybettiğini düşündürür. */
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
      <h2>Projeler</h2>

      {onExpressCreate && onExpressPrompt ? (
        <div className="express-create" style={{ marginBottom: '1.5rem', padding: '1rem', background: 'rgba(255,255,255,0.03)', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.1)' }}>
          <h3 style={{ margin: '0 0 0.5rem 0', fontSize: '1rem' }}>⚡ Tek Cümleyle Hızlı Başlat (Express Modu)</h3>
          <p className="hint" style={{ margin: '0 0 0.75rem 0' }}>Ne tür bir uygulama istediğinizi tek cümleyle yazın, sistem gereksinimleri ve planı anında hazırlasın.</p>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <input
              aria-label="Uygulama açıklaması"
              placeholder="Örn: Modern karanlık temalı bir yapılacaklar (Todo) listesi web uygulaması"
              value={expressPrompt ?? ''}
              onChange={(event) => onExpressPrompt(event.target.value)}
              style={{ flex: '1 1 300px' }}
            />
            <input
              aria-label="Proje adı (isteğe bağlı)"
              placeholder="Proje adı (isteğe bağlı)"
              value={expressName ?? ''}
              onChange={(event) => onExpressName ? onExpressName(event.target.value) : undefined}
              style={{ width: '180px' }}
            />
            <button type="button" onClick={onExpressCreate} disabled={!expressPrompt || expressPrompt.trim() === ''}>
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
              <span className={`pill pill--${project.status}`}>{projectStatusLabel(project.status)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
