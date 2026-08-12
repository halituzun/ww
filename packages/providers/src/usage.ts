import { randomUUID } from 'node:crypto';
import type { ClickHouseClient } from '@ww/db';
import type { ApiUsageRow } from '@ww/shared';

export type UsageSink = (row: ApiUsageRow) => Promise<void>;

// Gerçek sink: api_usage tablosuna yazar (mv_usage_daily / mv_provider_errors beslenir).
export function chUsageSink(ch: ClickHouseClient): UsageSink {
  return async (row) => {
    await ch.insert({
      table: 'api_usage',
      values: [{ ...row, created_at: new Date().toISOString() }],
      format: 'JSONEachRow',
    });
  };
}

export const newUsageId = (): string => randomUUID();
