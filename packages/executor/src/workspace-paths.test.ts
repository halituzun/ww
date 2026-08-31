import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutorError } from './errors.js';
import { WorkspacePaths, normalizeWorkspaceRelativePath } from './workspace-paths.js';

const cleanup: string[] = [];

async function temp(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanup.push(directory);
  return directory;
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('WorkspacePaths', () => {
  it.each([
    '../secret', 'src/../secret', '/tmp/secret', 'C:\\secret',
    '.git/config', '.GIT/config', 'src/.Git/x', `a\0b`,
  ])(
    'tehlikeli yolu reddeder: %s',
    (candidate) => {
      expect(() => normalizeWorkspaceRelativePath(candidate)).toThrowError(ExecutorError);
    },
  );

  it('workspace dışına çıkan symlink okumasını ve yazmasını reddeder', async () => {
    const root = await temp('ww-executor-root-');
    const outside = await temp('ww-executor-outside-');
    await writeFile(path.join(outside, 'secret.txt'), 'secret');
    await symlink(outside, path.join(root, 'escape'));
    const workspace = await new WorkspacePaths(root).initialize();

    await expect(workspace.resolveExisting('escape/secret.txt')).rejects.toMatchObject({ code: 'PATH_ESCAPE' });
    await expect(workspace.resolveForWrite('escape/new.txt')).rejects.toMatchObject({ code: 'PATH_ESCAPE' });
  });

  it('.git gerçek-yol takma adına giden workspace-içi symlinkleri reddeder', async () => {
    const root = await temp('ww-executor-git-alias-');
    await mkdir(path.join(root, '.git'));
    await writeFile(path.join(root, '.git/config'), 'secret git config');
    await symlink(path.join(root, '.git'), path.join(root, 'metadata'));
    const workspace = await new WorkspacePaths(root).initialize();
    await expect(workspace.resolveExisting('metadata/config')).rejects.toMatchObject({ code: 'PATH_INVALID' });
    await expect(workspace.resolveForWrite('metadata/new')).rejects.toMatchObject({ code: 'PATH_INVALID' });
  });

  it('yalnız beyan edilmiş hedefe atomik sibling rename ile yazar', async () => {
    const root = await temp('ww-executor-write-');
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'src/a.ts'), 'old');
    await chmod(path.join(root, 'src/a.ts'), 0o755);
    const workspace = await new WorkspacePaths(root).initialize();
    expect(workspace.assertDeclared('./src/a.ts', ['src/a.ts'])).toBe('src/a.ts');
    expect(() => workspace.assertDeclared('src/b.ts', ['src/a.ts'])).toThrow(/hedeflerinde değil/);

    let checkedBeforeRename = false;
    await workspace.atomicWrite('src/a.ts', 'new', async () => {
      checkedBeforeRename = true;
      expect(await readFile(path.join(root, 'src/a.ts'), 'utf8')).toBe('old');
    });
    expect(checkedBeforeRename).toBe(true);
    expect(await readFile(path.join(root, 'src/a.ts'), 'utf8')).toBe('new');
    expect((await stat(path.join(root, 'src/a.ts'))).mode & 0o777).toBe(0o755);
    expect((await readdir(path.join(root, 'src'))).filter((name) => name.startsWith('.ww-'))).toEqual([]);
  });

  it('başarısız son fence kontrolünde hedefi ve temp dosyalarını korur', async () => {
    const root = await temp('ww-executor-fence-');
    await writeFile(path.join(root, 'a.ts'), 'old');
    const workspace = await new WorkspacePaths(root).initialize();
    await expect(workspace.atomicWrite('a.ts', 'new', async () => {
      throw new ExecutorError('LOCK_REQUIRED', 'lock kaybedildi');
    })).rejects.toMatchObject({ code: 'LOCK_REQUIRED' });
    expect(await readFile(path.join(root, 'a.ts'), 'utf8')).toBe('old');
    expect((await readdir(root)).filter((name) => name.startsWith('.ww-'))).toEqual([]);
  });

  it('rename öncesi ancestor dışarı yönlendirilirse yazmayı reddeder ve taşınan temp dosyasını temizler', async () => {
    const root = await temp('ww-executor-ancestor-race-');
    const outside = await temp('ww-executor-ancestor-outside-');
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'src/a.ts'), 'workspace-old');
    await writeFile(path.join(outside, 'a.ts'), 'outside-safe');
    const workspace = await new WorkspacePaths(root).initialize();

    await expect(workspace.atomicWrite('src/a.ts', 'attacker-content', async () => {
      await rename(path.join(root, 'src'), path.join(root, 'src-before-swap'));
      await symlink(outside, path.join(root, 'src'));
    })).rejects.toMatchObject({ code: 'PATH_ESCAPE' });

    expect(await readFile(path.join(outside, 'a.ts'), 'utf8')).toBe('outside-safe');
    expect(await readFile(path.join(root, 'src-before-swap/a.ts'), 'utf8')).toBe('workspace-old');
    expect((await readdir(path.join(root, 'src-before-swap'))).filter((name) => name.startsWith('.ww-'))).toEqual([]);
  });

  it('rename öncesi ancestor büyük-küçük harfli .git takma adına çevrilirse yazmayı reddeder', async () => {
    const root = await temp('ww-executor-git-ancestor-race-');
    await mkdir(path.join(root, 'src'));
    await mkdir(path.join(root, '.GiT'));
    await writeFile(path.join(root, 'src/a.ts'), 'workspace-old');
    await writeFile(path.join(root, '.GiT/a.ts'), 'git-safe');
    const workspace = await new WorkspacePaths(root).initialize();

    await expect(workspace.atomicWrite('src/a.ts', 'attacker-content', async () => {
      await rename(path.join(root, 'src'), path.join(root, 'src-before-swap'));
      await symlink(path.join(root, '.GiT'), path.join(root, 'src'));
    })).rejects.toMatchObject({ code: 'PATH_INVALID' });

    expect(await readFile(path.join(root, '.GiT/a.ts'), 'utf8')).toBe('git-safe');
    expect(await readFile(path.join(root, 'src-before-swap/a.ts'), 'utf8')).toBe('workspace-old');
    expect((await readdir(path.join(root, 'src-before-swap'))).filter((name) => name.startsWith('.ww-'))).toEqual([]);
  });

  it('rename öncesi destination dışarı yönlendirilirse symlink hedefini değiştirmez', async () => {
    const root = await temp('ww-executor-destination-race-');
    const outside = await temp('ww-executor-destination-outside-');
    await writeFile(path.join(root, 'a.ts'), 'workspace-old');
    await writeFile(path.join(outside, 'victim.ts'), 'outside-safe');
    const workspace = await new WorkspacePaths(root).initialize();

    await expect(workspace.atomicWrite('a.ts', 'attacker-content', async () => {
      await unlink(path.join(root, 'a.ts'));
      await symlink(path.join(outside, 'victim.ts'), path.join(root, 'a.ts'));
    })).rejects.toMatchObject({ code: 'PATH_ESCAPE' });

    expect(await readFile(path.join(outside, 'victim.ts'), 'utf8')).toBe('outside-safe');
    expect((await readdir(root)).filter((name) => name.startsWith('.ww-'))).toEqual([]);
  });

  it('rename öncesi destination başka bir normal dosyayla değiştirilirse inode farkını reddeder', async () => {
    const root = await temp('ww-executor-destination-identity-race-');
    await writeFile(path.join(root, 'a.ts'), 'workspace-old');
    await writeFile(path.join(root, 'replacement.ts'), 'replacement-safe');
    const workspace = await new WorkspacePaths(root).initialize();

    await expect(workspace.atomicWrite('a.ts', 'attacker-content', async () => {
      await rename(path.join(root, 'a.ts'), path.join(root, 'a-before-swap.ts'));
      await rename(path.join(root, 'replacement.ts'), path.join(root, 'a.ts'));
    })).rejects.toMatchObject({ code: 'PATH_INVALID' });

    expect(await readFile(path.join(root, 'a.ts'), 'utf8')).toBe('replacement-safe');
    expect(await readFile(path.join(root, 'a-before-swap.ts'), 'utf8')).toBe('workspace-old');
    expect((await readdir(root)).filter((name) => name.startsWith('.ww-'))).toEqual([]);
  });

  it('rename öncesi destination büyük-küçük harfli .git takma adına çevrilirse git dosyasını değiştirmez', async () => {
    const root = await temp('ww-executor-git-destination-race-');
    await mkdir(path.join(root, '.GiT'));
    await writeFile(path.join(root, 'a.ts'), 'workspace-old');
    await writeFile(path.join(root, '.GiT/config'), 'git-safe');
    const workspace = await new WorkspacePaths(root).initialize();

    await expect(workspace.atomicWrite('a.ts', 'attacker-content', async () => {
      await unlink(path.join(root, 'a.ts'));
      await symlink(path.join(root, '.GiT/config'), path.join(root, 'a.ts'));
    })).rejects.toMatchObject({ code: 'PATH_INVALID' });

    expect(await readFile(path.join(root, '.GiT/config'), 'utf8')).toBe('git-safe');
    expect((await readdir(root)).filter((name) => name.startsWith('.ww-'))).toEqual([]);
  });

  it('edit_file için old metnin birebir ve tekil olmasını zorlar', async () => {
    const root = await temp('ww-executor-edit-');
    await writeFile(path.join(root, 'a.ts'), 'same same');
    const workspace = await new WorkspacePaths(root).initialize();
    await expect(workspace.editText('a.ts', 'same', 'new')).rejects.toMatchObject({ code: 'EDIT_MISMATCH' });
    await expect(workspace.editText('a.ts', 'missing', 'new')).rejects.toMatchObject({ code: 'EDIT_MISMATCH' });
    expect(await readFile(path.join(root, 'a.ts'), 'utf8')).toBe('same same');
  });
});
