import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCh } from './client.js';

export interface MigrationFile {
  name: string;
  sql: string;
}

export interface MigrateOptions {
  url?: string;
  database?: string;
  username?: string;
  password?: string;
  files?: MigrationFile[];
}

const MIG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

async function loadFiles(): Promise<MigrationFile[]> {
  const names = (await readdir(MIG_DIR)).filter((n) => n.endsWith('.sql')).sort();
  return Promise.all(
    names.map(async (name) => ({ name, sql: await readFile(join(MIG_DIR, name), 'utf8') })),
  );
}

const checksum = (sql: string): string => createHash('sha256').update(sql).digest('hex');

// İfadeler ";" + satır sonu ile ayrılır; SQL string'i içinde ";\n" kullanılmamalıdır.
// Tam satır yorumları ifadeden ayıklanır (ifadeye yapışık baş yorumlar CREATE'i düşürmesin).
const statements = (sql: string): string[] =>
  sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) =>
      s
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter((s) => s.length > 0);

export async function runMigrations(opts: MigrateOptions = {}): Promise<{ applied: string[] }> {
  const database = opts.database ?? process.env['WW_CH_DB'] ?? 'ww';
  const conn = { url: opts.url, username: opts.username, password: opts.password };

  const admin = createCh({ ...conn, database: 'default' });
  try {
    await admin.command({ query: `CREATE DATABASE IF NOT EXISTS ${database}` });
  } finally {
    await admin.close();
  }

  const ch = createCh({ ...conn, database });
  try {
    await ch.command({
      query: `CREATE TABLE IF NOT EXISTS _migrations
        (name String, checksum String, applied_at DateTime64(3, 'UTC') DEFAULT now64(3))
        ENGINE = MergeTree ORDER BY name`,
    });

    const rs = await ch.query({ query: 'SELECT name, checksum FROM _migrations', format: 'JSONEachRow' });
    const done = new Map((await rs.json<{ name: string; checksum: string }>()).map((r) => [r.name, r.checksum]));

    const applied: string[] = [];
    for (const f of opts.files ?? (await loadFiles())) {
      const sum = checksum(f.sql);
      const prev = done.get(f.name);
      if (prev === sum) continue;
      if (prev !== undefined) {
        throw new Error(`migration checksum mismatch: ${f.name} (dosya değişmiş; migration'lar yalnız-ileri olmalı)`);
      }
      for (const st of statements(f.sql)) {
        await ch.command({ query: st });
      }
      await ch.insert({ table: '_migrations', values: [{ name: f.name, checksum: sum }], format: 'JSONEachRow' });
      applied.push(f.name);
    }
    return { applied };
  } finally {
    await ch.close();
  }
}
