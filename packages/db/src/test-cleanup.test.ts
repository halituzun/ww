import { describe, expect, it } from 'vitest';
import { createCh, type ClickHouseClient } from './client.js';
import { clickhouseUp } from './testutil.js';
import { dropLeakedTestDatabases } from './test-cleanup.js';

const up = await clickhouseUp();

describe.skipIf(!up)('dropLeakedTestDatabases', () => {
  const stamp = Date.now() - 3_600_000; // 1 saat önce
  const leaked = `ww_leaktest_${stamp}`;
  const fresh = `ww_leaktest_${Date.now()}`;

  const admin = (): ClickHouseClient => createCh({ database: 'default' });

  it('eski sızıntıyı düşürür, taze olanı korur', async () => {
    const ch = admin();
    await ch.command({ query: `CREATE DATABASE IF NOT EXISTS ${leaked}` });
    await ch.command({ query: `CREATE DATABASE IF NOT EXISTS ${fresh}` });

    const dropped = await dropLeakedTestDatabases({
      prefix: 'ww_leaktest', olderThanMs: 60_000,
    });

    expect(dropped).toContain(leaked);
    // Koşan bir testin veritabanını silmek, o testi kırar.
    expect(dropped).not.toContain(fresh);

    await ch.command({ query: `DROP DATABASE IF EXISTS ${fresh}` });
    await ch.close();
  });

  it('eşik verilmezse hepsini düşürür', async () => {
    const ch = admin();
    const name = `ww_leaktest_all_${Date.now()}`;
    await ch.command({ query: `CREATE DATABASE IF NOT EXISTS ${name}` });
    const dropped = await dropLeakedTestDatabases({ prefix: 'ww_leaktest_all' });
    expect(dropped).toContain(name);
    await ch.close();
  });
});
