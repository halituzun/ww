import { listLatestApiProviders, listLatestRoleModels, type ClickHouseClient } from '@ww/db';
import { buildRoutingIndex, type RoutingIndex } from '@ww/providers';

/**
 * role_models + api_providers kayıtlarından ModelRouter'ın beklediği
 * yönlendirme indeksini kurar (docs/04 → Rol→Model Eşleme, Fallback).
 *
 * Index senkron sorgulanır; değişiklikleri yansıtmak için periyodik olarak
 * yeniden yüklenmelidir (sağlayıcı/eşleme paneli anlık değişebilir).
 */
export async function loadRoutingIndex(ch: ClickHouseClient): Promise<RoutingIndex> {
  const [roleModels, providers] = await Promise.all([
    listLatestRoleModels(ch),
    listLatestApiProviders(ch),
  ]);

  return buildRoutingIndex(
    roleModels.map((row) => ({
      role: row.role,
      modelRef: row.model_ref,
      fallbackRefs: row.fallback_refs,
    })),
    providers.map((row) => ({
      providerId: row.provider_id,
      enabled: row.enabled,
      isDefault: row.is_default,
      models: row.models,
    })),
  );
}
