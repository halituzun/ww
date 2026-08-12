import type { ClickHouseClient } from '@clickhouse/client';

// Son-durum okuma deseni (docs/01-mimari.md → Tutarlılık Kuralları):
// ReplacingMergeTree tablolarında FINAL yerine "ORDER BY version DESC LIMIT 1 BY id".
export async function latest<T>(
  ch: ClickHouseClient,
  table: string,
  idCol: string,
  where: Record<string, string | number> = {},
): Promise<T[]> {
  const keys = Object.keys(where);
  const conds = keys.length ? keys.map((k, i) => `${k} = {w${i}:String}`).join(' AND ') : '1';
  const params = Object.fromEntries(Object.values(where).map((v, i) => [`w${i}`, String(v)]));
  const rs = await ch.query({
    query: `SELECT * FROM ${table} WHERE ${conds} ORDER BY version DESC LIMIT 1 BY ${idCol}`,
    query_params: params,
    format: 'JSONEachRow',
  });
  return rs.json<T>();
}
