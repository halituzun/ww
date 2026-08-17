// docs/09 View → ViewModel → Service; docs/11 Faz 6 web önizleme.
//
// NEDEN VAR: panelin önizleme sekmesi sabit `VITE_PREVIEW_URL` env
// değişkenine bakıyor, yoksa `about:blank` gösteriyordu — projeye bağlı canlı
// önizleme yoktu. Artık gerçek süreç başlatılır, portu havuzdan alınır ve
// çıktısı (son 200 satır) panelde görünür.
import { useCallback, useEffect, useState } from 'react';
import {
  fetchPreviewStatus,
  startPreview,
  stopPreview,
  type PreviewStatus,
} from '../services/preview.js';

export const PREVIEW_POLL_MS = 5_000;

const IDLE: PreviewStatus = {
  projectId: '', running: false, hasIndexHtml: false, logs: [],
};

export interface PreviewViewModelPorts {
  fetchStatus?: typeof fetchPreviewStatus;
  start?: typeof startPreview;
  stop?: typeof stopPreview;
  pollMs?: number;
}

export function usePreviewViewModel(projectId: string, ports: PreviewViewModelPorts = {}) {
  const load = ports.fetchStatus ?? fetchPreviewStatus;
  const begin = ports.start ?? startPreview;
  const end = ports.stop ?? stopPreview;
  const pollMs = ports.pollMs ?? PREVIEW_POLL_MS;

  const [status, setStatus] = useState<PreviewStatus>(IDLE);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!projectId) return;
    let active = true;
    const refresh = (): void => {
      void load(projectId).then((next) => { if (active) setStatus(next); }).catch(() => undefined);
    };
    refresh();
    const timer = window.setInterval(refresh, pollMs);
    return () => { active = false; window.clearInterval(timer); };
  }, [projectId, load, pollMs]);

  const run = useCallback(async (action: 'start' | 'stop'): Promise<void> => {
    if (!projectId) return;
    setBusy(true);
    setError('');
    try {
      setStatus(await (action === 'start' ? begin(projectId) : end(projectId)));
    } catch (reason) {
      // Hata yutulursa kullanıcı önizlemenin açıldığını sanır ve boş
      // iframe'e bakar.
      setError(reason instanceof Error ? reason.message : 'Önizleme işlemi başarısız');
    } finally {
      setBusy(false);
    }
  }, [projectId, begin, end]);

  return {
    status,
    error,
    busy,
    start: () => run('start'),
    stop: () => run('stop'),
  };
}
