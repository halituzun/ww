// Panelin tek HTTP katmanı (MVVM: Model/Service tabanı).
// docs/09: View'da fetch yasaktır — her istek buradan geçer.
//
// Not: Vite dev sunucusu yalnız /health yolunu proxy'ler. Göreli yol üretilirse
// istek panele gider ve index.html döner; bu yüzden varsayılan API kökü açıktır.
export const DEFAULT_API_BASE = 'http://localhost:4000';

export interface RequestOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  sessionToken?: string;
  signal?: AbortSignal;
}

export interface WriteOptions extends RequestOptions {
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
}

export function apiUrl(baseUrl: string | undefined, path: string): string {
  const configured = baseUrl ?? import.meta.env['VITE_API_URL'] ?? DEFAULT_API_BASE;
  return `${configured.trim().replace(/\/+$/, '')}${path}`;
}

function sessionToken(options: RequestOptions): string {
  return options.sessionToken ?? import.meta.env['VITE_SESSION_TOKEN'] ?? '';
}

/** WebSocket gibi Authorization başlığı taşıyamayan kanallar için oturum tokenı. */
export function currentSessionToken(): string {
  return import.meta.env['VITE_SESSION_TOKEN'] ?? '';
}

export function authHeaders(options: RequestOptions, withBody: boolean): Record<string, string> {
  const headers: Record<string, string> = { authorization: `Bearer ${sessionToken(options)}` };
  if (withBody) headers['content-type'] = 'application/json';
  return headers;
}

async function ensureOk(response: Response, what: string): Promise<void> {
  if (response.ok) return;
  if (response.status === 401) {
    throw new Error(`${what}: yetkisiz — panel oturum tokenı (VITE_SESSION_TOKEN) server'ın WW_LOCAL_SESSION_TOKEN değeriyle aynı olmalı`);
  }
  throw new Error(`${what}: ${response.status}`);
}

// Yanlış hedefe giden istek HTML döndürür; ham JSON.parse hatası yerine nedeni söylenir.
async function parseJson(response: Response, what: string): Promise<unknown> {
  const text = await response.text();
  if (text.trim().length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    const contentType = response.headers.get('content-type') ?? 'bilinmiyor';
    throw new Error(`${what}: JSON beklendi ama '${contentType}' geldi — API adresi (VITE_API_URL) yanlış olabilir`);
  }
}

export async function getJson<T>(path: string, options: RequestOptions = {}, what = 'İstek başarısız'): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const init: RequestInit = options.signal ? { signal: options.signal } : {};
  const response = await fetchImpl(apiUrl(options.baseUrl, path), init);
  await ensureOk(response, what);
  return (await parseJson(response, what)) as T;
}

export async function requestJson<T>(path: string, options: WriteOptions, what = 'İstek başarısız'): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const withBody = options.body !== undefined;
  const init: RequestInit = { method: options.method, headers: authHeaders(options, withBody) };
  if (withBody) init.body = JSON.stringify(options.body);
  if (options.signal) init.signal = options.signal;

  const response = await fetchImpl(apiUrl(options.baseUrl, path), init);
  await ensureOk(response, what);
  return (await parseJson(response, what)) as T;
}

// Okuma uçlarında hata panelin akışını kesmemeli; boş sonuç dönülür.
export async function getJsonOr<T>(path: string, fallback: T, options: RequestOptions = {}): Promise<T> {
  try {
    return await getJson<T>(path, options);
  } catch {
    return fallback;
  }
}
