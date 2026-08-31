// Proje durum denetimleri — SALT GÖRÜNÜM (docs/08 → projeler: aç/duraklat/devam).
//
// NEDEN AYRI: App.tsx içinde tek satırda 404 karakterdi ve "duraklat mı devam
// mı" kararı görünümün içine gömülüydü; testi yoktu.
import { projectStatusLabel } from '../services/labels.js';

export function ProjectControls({ status, onStatus }: {
  readonly status: string;
  readonly onStatus: (next: 'running' | 'paused' | 'archived') => void;
}) {
  const paused = status === 'paused';

  return (
    <div className="project-controls">
      <span className={`pill pill--${status}`}>
        {/* Durum henüz gelmediyse boş rozet "durumsuz proje" yalanı olurdu. */}
        {status === '' ? 'yükleniyor' : projectStatusLabel(status)}
      </span>
      <button type="button" onClick={() => onStatus(paused ? 'running' : 'paused')}>
        {paused ? 'Devam et' : 'Duraklat'}
      </button>
      <button type="button" onClick={() => onStatus('archived')}>Arşivle</button>
    </div>
  );
}
