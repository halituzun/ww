import { createCh } from './client.js';

/**
 * Sızan test veritabanlarını düşürür.
 *
 * Entegrasyon testleri `ww_test_*` veritabanları yaratıp `afterAll` içinde
 * düşürür. Test ORTASINDA düşerse afterAll çalışmaz ve veritabanı kalır.
 * Bir gecede 84 tanesi birikip 3422 tablo yarattı; ClickHouse kaynak baskısı
 * altında eşzamanlı testleri HTTP hatasıyla düşürmeye başladı — yani sızıntı,
 * ilgisiz testleri kırık gösteriyordu.
 */
export async function dropLeakedTestDatabases(options: {
  prefix?: string;
  olderThanMs?: number;
} = {}): Promise<string[]> {
  const prefix = options.prefix ?? 'ww_test';
  const admin = createCh({ database: 'default' });
  try {
    const result = await admin.query({
      query: `SELECT name FROM system.databases WHERE name LIKE {pattern:String}`,
      query_params: { pattern: `${prefix}%` },
      format: 'JSONEachRow',
    });
    const names = (await result.json<{ name: string }>()).map((row) => row.name);

    // Ad sonundaki zaman damgası yeterince eskiyse düşür; koşan bir testin
    // veritabanını silmemek için eşik verilebilir.
    const cutoff = options.olderThanMs === undefined ? undefined : Date.now() - options.olderThanMs;
    const dropped: string[] = [];
    for (const name of names) {
      if (cutoff !== undefined) {
        const stamp = Number(/_(\d{10,})$/.exec(name)?.[1] ?? '0');
        if (stamp > cutoff) continue;
      }
      await admin.command({ query: `DROP DATABASE IF EXISTS \`${name}\`` });
      dropped.push(name);
    }
    return dropped;
  } finally {
    await admin.close();
  }
}
