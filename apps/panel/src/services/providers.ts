// Sağlayıcı yönetimi IO katmanı (MVVM: Model/Service).
// Ham API anahtarı yalnızca istek gövdesinde gider; yanıtlarda ve panel durumunda
// yalnız maskeli değer taşınır (docs/04 → Anahtar Güvenliği).

export interface Provider {
  provider_id: string;
  display_name: string;
  base_url: string;
  models: string[];
  enabled: boolean;
  is_default: boolean;
  fallback_order: number;
  keyConfigured: boolean;
  maskedKey: string;
  health_status?: string;
}

export interface ProviderRequestOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  sessionToken?: string;
  signal?: AbortSignal;
}

export interface SaveKeyResult {
  providerId: string;
  configured: boolean;
  maskedKey: string;
}

export interface ProviderConfigInput {
  providerId: string;
  displayName: string;
  baseUrl: string;
  models: string[];
  enabled: boolean;
  isDefault: boolean;
  fallbackOrder: number;
}

function apiUrl(baseUrl: string | undefined, path: string): string {
  const configured = baseUrl ?? import.meta.env['VITE_API_URL'] ?? '';
  return `${configured.trim().replace(/\/+$/, '')}${path}`;
}

function sessionToken(options: ProviderRequestOptions): string {
  return options.sessionToken ?? import.meta.env['VITE_SESSION_TOKEN'] ?? '';
}

function authHeaders(options: ProviderRequestOptions): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${sessionToken(options)}` };
}

async function ensureOk(response: Response, what: string): Promise<void> {
  if (response.ok) return;
  if (response.status === 401) {
    throw new Error(`${what}: yetkisiz — panel oturum tokenı (VITE_SESSION_TOKEN) server'ın WW_LOCAL_SESSION_TOKEN değeriyle aynı olmalı`);
  }
  throw new Error(`${what}: ${response.status}`);
}

export async function fetchProviders(options: ProviderRequestOptions = {}): Promise<Provider[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const init: RequestInit = options.signal ? { signal: options.signal } : {};
  const response = await fetchImpl(apiUrl(options.baseUrl, '/providers'), init);
  await ensureOk(response, 'Sağlayıcılar okunamadı');
  const body: unknown = await response.json();
  if (!Array.isArray(body)) throw new Error('Sağlayıcı yanıtı geçersiz');
  return body as Provider[];
}

export async function saveProviderKey(
  providerId: string,
  apiKey: string,
  options: ProviderRequestOptions = {},
): Promise<SaveKeyResult> {
  const key = apiKey.trim();
  if (key.length === 0) throw new Error('API anahtarı boş olamaz');

  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    apiUrl(options.baseUrl, `/providers/${encodeURIComponent(providerId)}/key`),
    { method: 'POST', headers: authHeaders(options), body: JSON.stringify({ apiKey: key }) },
  );
  await ensureOk(response, 'Anahtar kaydedilemedi');
  return (await response.json()) as SaveKeyResult;
}

export async function upsertProvider(
  input: ProviderConfigInput,
  options: ProviderRequestOptions = {},
): Promise<Provider> {
  const id = input.providerId.trim();
  if (id.length === 0) throw new Error('Sağlayıcı kimliği zorunludur');

  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(apiUrl(options.baseUrl, `/providers/${encodeURIComponent(id)}`), {
    method: 'PATCH',
    headers: authHeaders(options),
    body: JSON.stringify({
      displayName: input.displayName.trim(),
      baseUrl: input.baseUrl.trim(),
      models: input.models,
      enabled: input.enabled,
      isDefault: input.isDefault,
      fallbackOrder: input.fallbackOrder,
    }),
  });
  await ensureOk(response, 'Sağlayıcı kaydedilemedi');
  const saved = (await response.json()) as Omit<Provider, 'keyConfigured' | 'maskedKey'>;
  return { ...saved, keyConfigured: false, maskedKey: '' };
}
