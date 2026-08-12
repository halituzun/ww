import { createClient, type ClickHouseClient } from '@clickhouse/client';

export type { ClickHouseClient };

export interface ChConfig {
  url?: string;
  database?: string;
  username?: string;
  password?: string;
}

// Varsayılan portlar docker-compose.yml ile eşleşir (8124: bu makinede 8123 başka projede).
export function createCh(cfg: ChConfig = {}): ClickHouseClient {
  return createClient({
    url: cfg.url ?? process.env['WW_CH_URL'] ?? 'http://localhost:8124',
    database: cfg.database ?? process.env['WW_CH_DB'] ?? 'ww',
    username: cfg.username ?? process.env['WW_CH_USER'] ?? 'ww',
    password: cfg.password ?? process.env['WW_CH_PASS'] ?? 'ww',
    clickhouse_settings: { date_time_input_format: 'best_effort' },
  });
}
