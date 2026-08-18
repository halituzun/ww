// API test konsolu — SALT GÖRÜNÜM (docs/09 MVVM; docs/00 test ortamları).
import type { ApiArtifact } from '../services/projects.js';
import { useApiConsoleViewModel } from '../viewmodels/useApiConsoleViewModel.js';

export function ApiConsole({ projectId, artifacts }: {
  readonly projectId: string;
  readonly artifacts: readonly ApiArtifact[];
}) {
  const { path, setPath, result, error, busy, run } = useApiConsoleViewModel(projectId);

  return (
    <div className="api-console">
      <h3>API test konsolu</h3>
      {artifacts.length > 0 ? (
        <label>
          Uç seçin
          <select aria-label="API artifact" onChange={(event) => setPath(event.target.value)}>
            <option value="/">/</option>
            {artifacts.map((artifact) => (
              <option key={artifact.artifact_id} value={artifact.path}>{artifact.path}</option>
            ))}
          </select>
        </label>
      ) : <p className="hint">Projede kayıtlı API ucu yok; yolu elle yazabilirsiniz.</p>}

      <div className="api-console__row">
        <input
          aria-label="İstek yolu"
          value={path}
          onChange={(event) => setPath(event.target.value)}
        />
        <button type="button" onClick={() => void run()} disabled={busy}>Çalıştır</button>
      </div>

      {/* Hangi ADRESE gidildiği yazılır: yanlış sunucunun cevabını doğru
          sanmak konsolu yanıltıcı yapar. */}
      {error !== '' ? <p className="api-console__error">{error}</p> : null}
      {result === undefined ? null : (
        <>
          <code>GET {result.url} → {result.status}</code>
          <pre>{result.body}</pre>
        </>
      )}
    </div>
  );
}
