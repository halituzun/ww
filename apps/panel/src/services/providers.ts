// Sağlayıcı yönetimi IO katmanı (MVVM: Model/Service).
// Ham API anahtarı yalnızca istek gövdesinde gider; yanıtlarda ve panel durumunda
// yalnız maskeli değer taşınır (docs/04 → Anahtar Güvenliği).
import { getJson, requestJson, type RequestOptions } from './http.js';

export { DEFAULT_API_BASE } from './http.js';
export type { RequestOptions as ProviderRequestOptions } from './http.js';

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

export async function fetchProviders(options: RequestOptions = {}): Promise<Provider[]> {
  const body = await getJson<unknown>('/providers', options, 'Sağlayıcılar okunamadı');
  if (!Array.isArray(body)) throw new Error('Sağlayıcı yanıtı geçersiz');
  return body as Provider[];
}

export async function saveProviderKey(
  providerId: string,
  apiKey: string,
  options: RequestOptions = {},
): Promise<SaveKeyResult> {
  const key = apiKey.trim();
  if (key.length === 0) throw new Error('API anahtarı boş olamaz');

  return requestJson<SaveKeyResult>(
    `/providers/${encodeURIComponent(providerId)}/key`,
    { ...options, method: 'POST', body: { apiKey: key } },
    'Anahtar kaydedilemedi',
  );
}

export async function upsertProvider(
  input: ProviderConfigInput,
  options: RequestOptions = {},
): Promise<Provider> {
  const id = input.providerId.trim();
  if (id.length === 0) throw new Error('Sağlayıcı kimliği zorunludur');

  const saved = await requestJson<Omit<Provider, 'keyConfigured' | 'maskedKey'>>(
    `/providers/${encodeURIComponent(id)}`,
    {
      ...options,
      method: 'PATCH',
      body: {
        displayName: input.displayName.trim(),
        baseUrl: input.baseUrl.trim(),
        models: input.models,
        enabled: input.enabled,
        isDefault: input.isDefault,
        fallbackOrder: input.fallbackOrder,
      },
    },
    'Sağlayıcı kaydedilemedi',
  );
  return { ...saved, keyConfigured: false, maskedKey: '' };
}
