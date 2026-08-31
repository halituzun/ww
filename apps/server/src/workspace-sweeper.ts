import { readdir, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { ClickHouseClient } from '@ww/db';
import { SAFE_SLUG } from './runtime-context.js';

export interface OrphanWorkspaceReport {
  readonly workspaceBase: string;
  readonly activeSlugs: readonly string[];
  readonly orphanFolders: readonly string[];
  readonly dryRun: boolean;
  readonly deletedFolders: readonly string[];
}

export interface SweepOptions {
  readonly workspaceBase: string;
  readonly dryRun: boolean;
  readonly confirm?: boolean;
}

/**
 * ClickHouse'taki güncel aktif projeleri sorgular.
 * 'archived' statüsündeki veya DB'de hiç olmayan projeler yetim sayılır.
 */
export async function getActiveProjectSlugs(ch: ClickHouseClient): Promise<Set<string>> {
  const result = await ch.query({
    query: `SELECT slug, status FROM (
      SELECT project_id, slug, status FROM projects ORDER BY version DESC LIMIT 1 BY project_id
    ) WHERE status != 'archived'`,
    format: 'JSONEachRow',
  });
  const rows = (await result.json()) as { slug: string; status: string }[];
  return new Set(rows.map((r) => r.slug));
}

/**
 * Workspace dizinindeki yetim (projesi olmayan veya arşivlenmiş) klasörleri tespit eder.
 * Path traversal koruması: SAFE_SLUG kuralına uymayan veya kök dışına sızmaya çalışan klasörler güvenle reddedilir.
 */
export async function inspectWorkspaceOrphans(
  workspaceBase: string,
  activeSlugs: Set<string>,
): Promise<string[]> {
  if (!isAbsolute(workspaceBase)) {
    throw new Error(`workspace kökü mutlak yol olmalıdır: '${workspaceBase}'`);
  }

  let entries: string[] = [];
  try {
    entries = await readdir(workspaceBase);
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'ENOENT') {
      return [];
    }
    throw err;
  }

  const orphans: string[] = [];

  for (const entry of entries) {
    if (entry.startsWith('.')) continue; // .git, .DS_Store vb. atla
    if (!SAFE_SLUG.test(entry)) continue; // Geçersiz slug desenlerini atla

    const fullPath = resolve(join(workspaceBase, entry));
    // Path traversal koruması: Hedef yol workspaceBase dizini altında olmalıdır
    if (!fullPath.startsWith(resolve(workspaceBase))) {
      throw new Error(`Path traversal tespiti: '${entry}' workspace kökü dışına çıkamaz`);
    }

    const st = await stat(fullPath).catch(() => null);
    if (!st || !st.isDirectory()) continue;

    if (!activeSlugs.has(entry)) {
      orphans.push(entry);
    }
  }

  return orphans.sort();
}

/**
 * Workspace süpürücüsü.
 * `dryRun: true` (varsayılan) iken ASLA silme yapmaz, sadece silinecek adayları raporlar.
 * Silme işlemi yalnız `dryRun: false` ve `confirm: true` açık onayıyla gerçekleşir.
 */
export async function sweepWorkspaces(
  ch: ClickHouseClient,
  options: SweepOptions,
): Promise<OrphanWorkspaceReport> {
  const activeSlugs = await getActiveProjectSlugs(ch);
  const orphanFolders = await inspectWorkspaceOrphans(options.workspaceBase, activeSlugs);

  if (options.dryRun || !options.confirm) {
    return {
      workspaceBase: options.workspaceBase,
      activeSlugs: Array.from(activeSlugs).sort(),
      orphanFolders,
      dryRun: true,
      deletedFolders: [],
    };
  }

  const deletedFolders: string[] = [];

  for (const folder of orphanFolders) {
    if (!SAFE_SLUG.test(folder)) {
      throw new Error(`Güvenlik ihlali: geçersiz slug '${folder}'`);
    }
    const targetDir = resolve(join(options.workspaceBase, folder));
    if (!targetDir.startsWith(resolve(options.workspaceBase))) {
      throw new Error(`Güvenlik ihlali: '${folder}' workspace dışına çıkamaz`);
    }

    await rm(targetDir, { recursive: true, force: true });
    deletedFolders.push(folder);
  }

  return {
    workspaceBase: options.workspaceBase,
    activeSlugs: Array.from(activeSlugs).sort(),
    orphanFolders,
    dryRun: false,
    deletedFolders,
  };
}
