// Kayıtlı sağlayıcılardan çalışır adaptör haritası kurar.
//
// Orkestrasyon runtime'ı `Map<string, LlmProvider>` bekler ama bu haritayı
// üreten bir yer yoktu; sağlık kontrolü de bu yüzden gerçek ping atamıyor,
// yalnız anahtarın varlığına bakabiliyordu (docs/04 1 token'lık ping istiyor).
import { AnthropicAdapter } from './adapters/anthropic.js';
import { OpenAiAdapter } from './adapters/openai.js';
import { createDeepseekAdapter } from './adapters/deepseek.js';
import type { LlmProvider } from './types.js';

/** api_providers satırının bu modülün ihtiyaç duyduğu alt kümesi. */
export interface ProviderRecord {
  provider_id: string;
  base_url: string;
  enabled: boolean;
  models: readonly string[];
  key_ref: string;
}

export interface KeyLookup {
  get: (keyRef: string) => Promise<string | undefined>;
}

export type SkipReason = 'disabled' | 'no_key' | 'no_base_url' | 'error';

export interface SkippedProvider {
  providerId: string;
  reason: SkipReason;
  detail?: string;
}

export interface ProviderRegistry {
  providers: Map<string, LlmProvider>;
  /** Kurulamayan sağlayıcılar sessizce kaybolmaz; sebebiyle raporlanır. */
  skipped: SkippedProvider[];
}

function createAdapter(record: ProviderRecord, apiKey: string): LlmProvider | { skip: SkipReason } {
  const models = [...record.models];

  if (record.provider_id === 'anthropic') {
    return new AnthropicAdapter({
      apiKey,
      ...(record.base_url === '' ? {} : { baseURL: record.base_url }),
      ...(models.length === 0 ? {} : { models }),
    });
  }

  if (record.provider_id === 'openai') {
    return new OpenAiAdapter({
      apiKey,
      ...(record.base_url === '' ? {} : { baseURL: record.base_url }),
      ...(models.length === 0 ? {} : { models }),
    });
  }

  if (record.provider_id === 'deepseek') {
    return record.base_url === ''
      ? createDeepseekAdapter(apiKey)
      : createDeepseekAdapter(apiKey, record.base_url);
  }

  // Bilinmeyen sağlayıcı OpenAI-uyumlu varsayılır; ama nereye bağlanacağını
  // bilmeden adaptör kurmak sessiz bir yanlış hedef demektir.
  if (record.base_url === '') return { skip: 'no_base_url' };
  return new OpenAiAdapter({
    apiKey,
    baseURL: record.base_url,
    id: record.provider_id,
    ...(models.length === 0 ? {} : { models }),
  });
}

export async function buildProviderRegistry(
  records: readonly ProviderRecord[],
  keys: KeyLookup,
): Promise<ProviderRegistry> {
  const providers = new Map<string, LlmProvider>();
  const skipped: SkippedProvider[] = [];

  for (const record of records) {
    if (!record.enabled) {
      skipped.push({ providerId: record.provider_id, reason: 'disabled' });
      continue;
    }

    try {
      const keyRef = record.key_ref.trim() === '' ? record.provider_id : record.key_ref;
      const apiKey = await keys.get(keyRef);
      if (apiKey === undefined || apiKey.trim() === '') {
        skipped.push({ providerId: record.provider_id, reason: 'no_key' });
        continue;
      }

      const adapter = createAdapter(record, apiKey);
      if ('skip' in adapter) {
        skipped.push({ providerId: record.provider_id, reason: adapter.skip });
        continue;
      }
      providers.set(record.provider_id, adapter);
    } catch (reason) {
      // Tek sağlayıcının hatası tüm kaydı düşürmemeli.
      skipped.push({
        providerId: record.provider_id,
        reason: 'error',
        detail: reason instanceof Error ? reason.message : String(reason),
      });
    }
  }

  return { providers, skipped };
}
