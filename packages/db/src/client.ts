import { createClient, type ClickHouseClient } from '@clickhouse/client';

export type { ClickHouseClient };

// exactOptionalPropertyTypes açık: çağıranlar opsiyonel alanları yayabilsin diye
// `| undefined` açıkça belirtilir.
export interface ChConfig {
  url?: string | undefined;
  database?: string | undefined;
  username?: string | undefined;
  password?: string | undefined;
  requestTimeoutMs?: number | undefined;
}

// Varsayılan portlar docker-compose.yml ile eşleşir (8124: bu makinede 8123 başka projede).
export function createCh(cfg: ChConfig = {}): ClickHouseClient {
  return createClient({
    url: cfg.url ?? process.env['WW_CH_URL'] ?? 'http://localhost:8124',
    database: cfg.database ?? process.env['WW_CH_DB'] ?? 'ww',
    username: cfg.username ?? process.env['WW_CH_USER'] ?? 'ww',
    password: cfg.password ?? process.env['WW_CH_PASS'] ?? 'ww',
    request_timeout: cfg.requestTimeoutMs ?? 30_000,
    clickhouse_settings: { date_time_input_format: 'best_effort' },
  });
}
