import type { HealthReport } from '@ww/shared';

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_RETRIES = 1;

export interface HealthRequestOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  retries?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function endpoint(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  return normalized ? `${normalized}/health` : '/health';
}

function isHealthReport(value: unknown): value is HealthReport {
  if (!value || typeof value !== 'object') return false;
  const report = value as Record<string, unknown>;
  return typeof report['ok'] === 'boolean'
    && typeof report['clickhouse'] === 'boolean'
    && typeof report['redis'] === 'boolean'
    && report['ok'] === (report['clickhouse'] && report['redis']);
}

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

export async function fetchHealth(options: HealthRequestOptions = {}): Promise<HealthReport> {
  const retries = options.retries ?? DEFAULT_RETRIES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(retries) || retries < 0) throw new Error('retries geçersiz');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs geçersiz');

  const fetchImpl = options.fetchImpl ?? fetch;
  const url = endpoint(options.baseUrl ?? import.meta.env['VITE_API_BASE_URL'] ?? '');
  let lastError = new Error('Sağlık isteği başarısız');

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) forwardAbort();
    else options.signal?.addEventListener('abort', forwardAbort, { once: true });

    const timeout = globalThis.setTimeout(
      () => controller.abort(new Error(`Sağlık isteği ${timeoutMs} ms içinde tamamlanmadı`)),
      timeoutMs,
    );

    try {
      const response = await fetchImpl(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`Sağlık isteği başarısız: ${response.status}`);
      const body: unknown = await response.json();
      if (!isHealthReport(body)) throw new Error('Sağlık yanıtı geçersiz');
      return body;
    } catch (reason) {
      lastError = asError(reason);
      if (options.signal?.aborted || attempt === retries) throw lastError;
    } finally {
      globalThis.clearTimeout(timeout);
      options.signal?.removeEventListener('abort', forwardAbort);
    }
  }

  throw lastError;
}
