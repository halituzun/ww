// Web önizleme — SALT GÖRÜNÜM (docs/09 MVVM; docs/10 test ortamları).
import { usePreviewViewModel } from '../viewmodels/usePreviewViewModel.js';

export function PreviewPanel({ projectId }: { readonly projectId: string }) {
  const { status, error, busy, start, stop } = usePreviewViewModel(projectId);

  return (
    <div className="preview-frame">
      <div className="device-bar">
        <span>Web önizleme</span>
        {status.running
          ? <button type="button" onClick={() => void stop()} disabled={busy}>Durdur</button>
          : <button type="button" onClick={() => void start()} disabled={busy}>Başlat</button>}
        {/* Durum METİNLE yazılır; boş bir iframe "çalışıyor" sanılmamalı. */}
        <strong>{status.running ? `çalışıyor · ${status.url}` : 'kapalı'}</strong>
      </div>

      {error !== '' ? <p className="preview__error">{error}</p> : null}

      {status.running && !status.hasIndexHtml ? (
        // Sahte bir "uygulama çalışıyor" görüntüsü vermemek için sınır açıkça
        // söylenir: sandbox'ta paket kurulamadığı için paketleyici yok.
        <p className="hint">
          Projede <code>index.html</code> yok; önizleme çalışma alanının dosya
          listesini gösteriyor (sandbox'ta paketleyici kurulamıyor).
        </p>
      ) : null}

      <iframe
        title="Proje önizleme"
        src={status.url ?? 'about:blank'}
        sandbox="allow-scripts allow-same-origin"
      />

      {status.logs.length > 0 ? (
        <details className="preview__logs">
          <summary>Süreç günlüğü ({status.logs.length} satır)</summary>
          <pre>{status.logs.slice(-50).join('\n')}</pre>
        </details>
      ) : null}
    </div>
  );
}
