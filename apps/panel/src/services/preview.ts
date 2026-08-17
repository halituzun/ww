// Önizleme süreç uçları (docs/05 dev-server yaşam döngüsü, docs/11 Faz 6).
import { getJson, requestJson, type RequestOptions } from './http.js';

export interface PreviewStatus {
  projectId: string;
  running: boolean;
  port?: number | undefined;
  url?: string | undefined;
  hasIndexHtml: boolean;
  logs: string[];
}

const scope = (projectId: string, path: string): string => `/projects/${projectId}/preview${path}`;

export const fetchPreviewStatus = (
  projectId: string,
  options: RequestOptions = {},
): Promise<PreviewStatus> =>
  getJson<PreviewStatus>(scope(projectId, ''), options, 'Önizleme durumu alınamadı');

export const startPreview = (
  projectId: string,
  options: RequestOptions = {},
): Promise<PreviewStatus> =>
  requestJson<PreviewStatus>(scope(projectId, '/start'),
    { ...options, method: 'POST' }, 'Önizleme başlatılamadı');

export const stopPreview = (
  projectId: string,
  options: RequestOptions = {},
): Promise<PreviewStatus> =>
  requestJson<PreviewStatus>(scope(projectId, '/stop'),
    { ...options, method: 'POST' }, 'Önizleme durdurulamadı');
