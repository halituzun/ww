// API test konsolu (docs/00 → "API test konsolu: endpoint listesi + istek
// gönderme"; docs/11 Faz 6 → "API projesinin konsoldan test edilmesi").
//
// NEDEN VAR: konsol isteği `${apiBase}${path}` ile WW SUNUCUSUNA atıyordu —
// üretilen projenin API'sine değil. Yani ww'nin kendi `/health` cevabını
// projenin cevabıymış gibi gösteriyordu. Yanlış sunucunun cevabını doğru
// sanmak, konsolu işe yaramaz değil YANILTICI yapar.
//
// Artık istek projenin ÇALIŞAN sunucusuna gider. Sunucu kapalıysa istek
// atılmaz ve bu açıkça söylenir.
import { useCallback, useState } from 'react';
import { fetchPreviewStatus, type PreviewStatus } from '../services/preview.js';
import { sendApiConsoleRequest } from '../services/api-console.js';

export interface ApiConsoleResult {
  readonly status: number | undefined;
  readonly body: string;
  readonly url: string;
}

export interface ApiConsolePorts {
  fetchStatus?: typeof fetchPreviewStatus;
  send?: (url: string) => Promise<{ status: number; text: string }>;
}

export const SERVER_OFF_NOTE =
  'Projenin sunucusu çalışmıyor. Önizleme sekmesinden başlatın; '
  + 'aksi halde konsol başka bir sunucunun cevabını gösterirdi.';

export function useApiConsoleViewModel(projectId: string, ports: ApiConsolePorts = {}) {
  const loadStatus = ports.fetchStatus ?? fetchPreviewStatus;
  const send = ports.send ?? sendApiConsoleRequest;

  const [path, setPath] = useState('/');
  const [result, setResult] = useState<ApiConsoleResult | undefined>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const run = useCallback(async (): Promise<void> => {
    if (projectId === '') return;
    setBusy(true);
    setError('');
    setResult(undefined);
    try {
      const status: PreviewStatus = await loadStatus(projectId);
      if (!status.running || status.url === undefined) {
        setError(SERVER_OFF_NOTE);
        return;
      }
      const url = new URL(path.startsWith('/') ? path.slice(1) : path, status.url).toString();
      const response = await send(url);
      setResult({ status: response.status, body: response.text, url });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'İstek başarısız');
    } finally {
      setBusy(false);
    }
  }, [projectId, path, loadStatus, send]);

  return { path, setPath, result, error, busy, run };
}
