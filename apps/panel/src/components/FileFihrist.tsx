// Fihrist paneli — SALT GÖRÜNÜM (docs/09 MVVM).
//
// docs/11 Faz 5: "bir dosyanın fihristinden ilgili göreve ve narrator
// anlatısına gidilir". Bu bağlar veride vardı ama panelde hiç görünmüyordu.
import type { FileIndex } from '../services/projects.js';
import { useFileFihristViewModel } from '../viewmodels/useFileFihristViewModel.js';

export function FileFihrist({ projectId, file, onSelectTask }: {
  readonly projectId: string;
  readonly file: FileIndex | undefined;
  readonly onSelectTask?: ((taskId: string) => void) | undefined;
}) {
  const {
    relatedTaskIds, relatedArtifactIds, artifact, openArtifact,
    narrative, error, loading, explain,
  } = useFileFihristViewModel(projectId, file);

  if (file === undefined) {
    return <p className="hint">Fihristi görmek için bir dosya seçin.</p>;
  }

  return (
    <section className="fihrist" aria-label="Fihrist">
      <div className="section-heading">
        <h4>Fihrist</h4>
        <small><code>{file.file_path}</code></small>
      </div>

      <dl className="fihrist__meta">
        <dt>Katman</dt><dd>{file.layer}</dd>
        <dt>Değişiklik</dt><dd>{file.change_count}</dd>
        <dt>Son commit</dt>
        <dd>{file.last_commit_hash === '' ? '—' : <code>{file.last_commit_hash.slice(0, 8)}</code>}</dd>
      </dl>

      <h5>Bu dosyayı üreten işler</h5>
      {relatedTaskIds.length === 0 ? (
        <p className="hint">Bu dosyaya bağlı görev kaydı yok.</p>
      ) : (
        <ul className="fihrist__tasks">
          {relatedTaskIds.map((taskId) => (
            <li key={taskId}>
              <button type="button" className="linklike" onClick={() => onSelectTask?.(taskId)}>
                <code>{taskId.slice(0, 8)}</code>
              </button>
            </li>
          ))}
        </ul>
      )}

      <h5>Bu dosyadan üretilen çıktılar</h5>
      {relatedArtifactIds.length === 0 ? (
        <p className="hint">Bu dosyaya bağlı çıktı kaydı yok.</p>
      ) : (
        <ul className="fihrist__tasks">
          {relatedArtifactIds.map((artifactId) => (
            <li key={artifactId}>
              <button
                type="button"
                className="linklike"
                onClick={() => void openArtifact(artifactId)}
              >
                <code>{artifactId.slice(0, 8)}</code>
              </button>
            </li>
          ))}
        </ul>
      )}
      {artifact === undefined ? null : (
        <dl className="fihrist__meta">
          <dt>Çıktı</dt><dd>{artifact.name} · {artifact.type}</dd>
          <dt>Özet</dt><dd>{artifact.summary === '' ? '—' : artifact.summary}</dd>
          <dt>Commit</dt>
          <dd>{artifact.commitHash === '' ? '—' : <code>{artifact.commitHash.slice(0, 8)}</code>}</dd>
        </dl>
      )}

      <button type="button" onClick={() => void explain()} disabled={loading}>
        {loading ? 'Anlatı hazırlanıyor…' : 'Bu dosya nasıl yapıldı?'}
      </button>
      {/* Hata renkle değil, metinle bildirilir. */}
      {error !== '' ? <p className="fihrist__error">{error}</p> : null}
      {narrative !== '' ? <p className="fihrist__narrative">{narrative}</p> : null}
    </section>
  );
}
