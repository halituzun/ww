import type { ClickHouseClient } from '@clickhouse/client';
import { RepositoryConflictError, StoredRecordError, nextRepositoryVersion, readAfterUncertainWrite, readRowsAfterAcknowledgedWrite, storedDateTime, storedRecord, storedString, storedStringArray, storedUInt64, storedUnsignedInteger, uncertainWriteError, type UInt64String } from './types.js';

export interface ApiProviderRow {
  readonly provider_id: string;
  readonly display_name: string;
  readonly base_url: string;
  readonly enabled: boolean;
  readonly is_default: boolean;
  readonly fallback_order: number;
  readonly models: readonly string[];
  readonly key_ref: string;
  readonly health_status: string;
  readonly last_health_check: string;
  readonly updated_at: string;
  readonly version: UInt64String;
}
export type UpsertApiProviderInput = Omit<ApiProviderRow, 'version'>;
const COLUMNS = 'provider_id,display_name,base_url,enabled,is_default,fallback_order,models,key_ref,health_status,last_health_check,updated_at,version';

function bool(value: unknown, field: string): boolean {
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  throw new StoredRecordError(field, value);
}
function parse(value: unknown): ApiProviderRow {
  const row = storedRecord(value, 'api_providers');
  const health = storedString(row['health_status'], 'api_providers.health_status');
  if (health.length === 0) throw new StoredRecordError('api_providers.health_status', health);
  return Object.freeze({
    provider_id: storedString(row['provider_id'], 'api_providers.provider_id'), display_name: storedString(row['display_name'], 'api_providers.display_name'), base_url: storedString(row['base_url'], 'api_providers.base_url'), enabled: bool(row['enabled'], 'api_providers.enabled'), is_default: bool(row['is_default'], 'api_providers.is_default'), fallback_order: storedUnsignedInteger(row['fallback_order'], 'api_providers.fallback_order', 255), models: storedStringArray(row['models'], 'api_providers.models'), key_ref: storedString(row['key_ref'], 'api_providers.key_ref'), health_status: health, last_health_check: storedDateTime(row['last_health_check'], 'api_providers.last_health_check'), updated_at: storedDateTime(row['updated_at'], 'api_providers.updated_at'), version: storedUInt64(row['version'], 'api_providers.version'),
  });
}
async function readRows(ch: ClickHouseClient, providerId?: string): Promise<ApiProviderRow[]> {
  const where = providerId === undefined ? '' : ' WHERE provider_id = {providerId:String}';
  const result = await ch.query({ query: `SELECT ${COLUMNS} FROM api_providers${where} ORDER BY provider_id ASC, version DESC`, query_params: providerId === undefined ? {} : { providerId }, format: 'JSONEachRow' });
  return (await result.json<unknown>()).map(parse);
}
function sameContent(left: ApiProviderRow, right: UpsertApiProviderInput): boolean {
  return left.provider_id === right.provider_id && left.display_name === right.display_name && left.base_url === right.base_url && left.enabled === right.enabled && left.is_default === right.is_default && left.fallback_order === right.fallback_order && JSON.stringify(left.models) === JSON.stringify(right.models) && left.key_ref === right.key_ref && left.health_status === right.health_status && left.last_health_check === right.last_health_check && left.updated_at === right.updated_at;
}
export async function listLatestApiProviders(ch: ClickHouseClient, limit = 100): Promise<readonly ApiProviderRow[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error('provider limiti gecersiz');
  const result = await ch.query({ query: `SELECT ${COLUMNS} FROM api_providers WHERE (provider_id,version) IN (SELECT provider_id,max(version) FROM api_providers GROUP BY provider_id) ORDER BY provider_id ASC LIMIT {limit:UInt32}`, query_params: { limit }, format: 'JSONEachRow' });
  return (await result.json<unknown>()).map(parse);
}
export async function getLatestApiProvider(ch: ClickHouseClient, providerId: string): Promise<ApiProviderRow | null> {
  const id = providerId.trim();
  if (id.length === 0 || id.length > 128 || /\s/.test(id)) throw new Error('provider id gecersiz');
  return (await readRows(ch, id))[0] ?? null;
}
export async function upsertApiProvider(ch: ClickHouseClient, input: UpsertApiProviderInput): Promise<ApiProviderRow> {
  const id = input.provider_id.trim();
  if (id.length === 0 || id.length > 128 || /\s/.test(id)) throw new Error('provider id gecersiz');
  const current = await getLatestApiProvider(ch, id);
  const normalized = { ...input, provider_id: id };
  if (current !== null && sameContent(current, normalized)) return current;
  const row: ApiProviderRow = Object.freeze({ ...normalized, version: nextRepositoryVersion(current?.version) });
  try { await ch.insert({ table: 'api_providers', values: [row], format: 'JSONEachRow' }); } catch (error) {
    const observed = await readAfterUncertainWrite(`api-provider:${id}`, error, () => readRows(ch, id));
    if (observed.length > 0) return observed[0]!;
    throw uncertainWriteError(`api-provider:${id}`, error);
  }
  const observed = await readRowsAfterAcknowledgedWrite(`api-provider:${id}`, row, () => readRows(ch, id));
  if (observed.length === 0) throw new RepositoryConflictError(`provider yazimi okunamadi: ${id}`);
  return observed[0]!;
}
