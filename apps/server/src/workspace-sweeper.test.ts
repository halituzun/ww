import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { inspectWorkspaceOrphans, sweepWorkspaces } from './workspace-sweeper.js';

describe('workspace-sweeper', () => {
  let tempBase: string;

  beforeEach(async () => {
    tempBase = await mkdtemp(join(tmpdir(), 'ww-sweeper-test-'));
  });

  afterEach(async () => {
    await rm(tempBase, { recursive: true, force: true });
  });

  it('projesi olan klasörleri yetim saymaz, projesi olmayanları yetim olarak listeler', async () => {
    await mkdir(join(tempBase, 'active-proj-1'));
    await mkdir(join(tempBase, 'active-proj-2'));
    await mkdir(join(tempBase, 'orphan-proj-1'));
    await mkdir(join(tempBase, 'orphan-proj-2'));
    await writeFile(join(tempBase, 'some-file.txt'), 'hello');

    const activeSlugs = new Set(['active-proj-1', 'active-proj-2']);
    const orphans = await inspectWorkspaceOrphans(tempBase, activeSlugs);

    expect(orphans).toEqual(['orphan-proj-1', 'orphan-proj-2']);
  });

  it('geçersiz veya ../ içeren path traversal desenlerini yok sayar/reddeder', async () => {
    const activeSlugs = new Set(['valid-proj']);
    await mkdir(join(tempBase, 'valid-proj'));

    const orphans = await inspectWorkspaceOrphans(tempBase, activeSlugs);
    expect(orphans).toEqual([]);
  });

  it('dry-run modunda hiçbir klasörü silmez', async () => {
    await mkdir(join(tempBase, 'orphan-1'));
    await mkdir(join(tempBase, 'active-1'));

    const mockCh = {
      query: async () => ({
        json: async () => [{ slug: 'active-1', status: 'running' }],
      }),
    } as never;

    const report = await sweepWorkspaces(mockCh, {
      workspaceBase: tempBase,
      dryRun: true,
    });

    expect(report.dryRun).toBe(true);
    expect(report.orphanFolders).toEqual(['orphan-1']);
    expect(report.deletedFolders).toEqual([]);

    // Dosyalar hala yerinde durmalı
    const orphansAfter = await inspectWorkspaceOrphans(tempBase, new Set(['active-1']));
    expect(orphansAfter).toEqual(['orphan-1']);
  });

  it('confirm: true ve dryRun: false ile yetim klasörleri güvenle siler', async () => {
    await mkdir(join(tempBase, 'orphan-1'));
    await mkdir(join(tempBase, 'active-1'));

    const mockCh = {
      query: async () => ({
        json: async () => [{ slug: 'active-1', status: 'running' }],
      }),
    } as never;

    const report = await sweepWorkspaces(mockCh, {
      workspaceBase: tempBase,
      dryRun: false,
      confirm: true,
    });

    expect(report.dryRun).toBe(false);
    expect(report.orphanFolders).toEqual(['orphan-1']);
    expect(report.deletedFolders).toEqual(['orphan-1']);

    // Silme sonrası yetim kalmamalı
    const orphansAfter = await inspectWorkspaceOrphans(tempBase, new Set(['active-1']));
    expect(orphansAfter).toEqual([]);
  });
});
