import {
  mkdir,
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import type { BigIntStats, Dirent } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ExecutorError } from './errors.js';

const NULL_BYTE = String.fromCharCode(0);
const MAX_CLEANUP_DIRECTORIES = 10_000;

interface FileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

interface DirectorySnapshot {
  readonly path: string;
  readonly identity: FileIdentity;
}

type DestinationSnapshot =
  | { readonly exists: false }
  | {
    readonly exists: true;
    readonly identity: FileIdentity;
    readonly mode: number;
    readonly realPath: string;
  };

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function identityOf(info: BigIntStats): FileIdentity {
  return { device: info.dev, inode: info.ino };
}

function hasIdentity(info: BigIntStats, expected: FileIdentity): boolean {
  return info.dev === expected.device && info.ino === expected.inode;
}

function identitiesEqual(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function normalizeWorkspaceRelativePath(input: string): string {
  if (input.length === 0 || input.includes(NULL_BYTE)) {
    throw new ExecutorError('PATH_INVALID', 'Workspace yolu boş veya null byte içeriyor');
  }
  if (path.isAbsolute(input) || path.win32.isAbsolute(input)) {
    throw new ExecutorError('PATH_INVALID', 'Mutlak workspace yolu kullanılamaz');
  }
  const portable = input.replaceAll('\\', '/');
  const segments = portable.split('/');
  if (segments.some((segment) => segment === '..')) {
    throw new ExecutorError('PATH_ESCAPE', 'Workspace yolu .. bileşeni içeremez');
  }
  if (segments.some((segment) => segment.toLowerCase() === '.git')) {
    throw new ExecutorError('PATH_INVALID', '.git yalnız GitWorkspace üzerinden yönetilir');
  }
  const normalized = path.posix.normalize(portable).replace(/^\.\//, '');
  if (normalized === '.' || normalized.length === 0 || normalized.startsWith('../')) {
    throw new ExecutorError('PATH_INVALID', 'Bir workspace dosya yolu gereklidir');
  }
  return normalized;
}

export class WorkspacePaths {
  readonly #rootInput: string;
  #rootReal: string | undefined;
  #gitReal: string | undefined;

  constructor(workspaceRoot: string) {
    if (!path.isAbsolute(workspaceRoot)) {
      throw new ExecutorError('PATH_INVALID', 'Workspace kökü mutlak olmalıdır');
    }
    this.#rootInput = path.resolve(workspaceRoot);
  }

  get root(): string {
    return this.#rootReal ?? this.#rootInput;
  }

  async initialize(): Promise<this> {
    const resolved = await realpath(this.#rootInput);
    const info = await stat(resolved);
    if (!info.isDirectory()) {
      throw new ExecutorError('PATH_INVALID', 'Workspace kökü bir dizin olmalıdır');
    }
    this.#rootReal = resolved;
    try {
      this.#gitReal = await realpath(path.join(resolved, '.git'));
    } catch {
      this.#gitReal = undefined;
    }
    return this;
  }

  assertDeclared(relativePath: string, declaredTargets: readonly string[]): string {
    const normalized = normalizeWorkspaceRelativePath(relativePath);
    const targets = new Set(declaredTargets.map(normalizeWorkspaceRelativePath));
    if (!targets.has(normalized)) {
      throw new ExecutorError('TARGET_NOT_DECLARED', `Dosya görev hedeflerinde değil: ${normalized}`);
    }
    return normalized;
  }

  async resolveExisting(relativePath: string): Promise<string> {
    await this.#ensureInitialized();
    const normalized = normalizeWorkspaceRelativePath(relativePath);
    const candidate = path.join(this.root, ...normalized.split('/'));
    let resolved: string;
    try {
      resolved = await realpath(candidate);
    } catch (error) {
      throw new ExecutorError('FILE_NOT_FOUND', `Dosya bulunamadı: ${normalized}`, {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    this.#assertInside(resolved);
    this.#assertNotGit(resolved);
    return resolved;
  }

  /**
   * Çalışma alanındaki dosyaları listeler (docs/05 → `list_dir`).
   *
   * NEDEN VAR: worker hangi dosyaların var olduğunu göremiyordu. Canlı koşuda
   * ilk sorusu birebir şuydu: "Workspace'te hangi dosyalar mevcut?" — araç
   * olmadığı için görev durup kullanıcı cevabını bekledi ve bir tur boşa gitti.
   *
   * Listeleme kapsam DIŞINA çıkamaz: `.git` ve sembolik bağlantı hedefleri
   * kök dışına işaret ediyorsa atlanır.
   */
  async listFiles(relativeDir: string, maxEntries = 500): Promise<readonly string[]> {
    await this.#ensureInitialized();
    const normalized = relativeDir.trim() === '' || relativeDir.trim() === '.'
      ? ''
      : normalizeWorkspaceRelativePath(relativeDir);
    const base = normalized === '' ? this.root : path.join(this.root, ...normalized.split('/'));
    let resolved: string;
    try {
      resolved = await realpath(base);
    } catch (error) {
      throw new ExecutorError('FILE_NOT_FOUND', `Dizin bulunamadı: ${normalized || '.'}`, {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    this.#assertInside(resolved);

    const out: string[] = [];
    const walk = async (directory: string, prefix: string): Promise<void> => {
      if (out.length >= maxEntries) return;
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (out.length >= maxEntries) return;
        // `.git` içeriği agent'a açılmaz: depo iç yapısı iş değildir.
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        const child = path.join(directory, entry.name);
        const label = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory()) {
          await walk(child, label);
        } else if (entry.isFile()) {
          out.push(label);
        }
        // Sembolik bağlantılar atlanır: hedefi kök dışına çıkabilir.
      }
    };
    await walk(resolved, normalized);
    return Object.freeze(out);
  }

  async resolveForWrite(relativePath: string): Promise<string> {
    await this.#ensureInitialized();
    const normalized = normalizeWorkspaceRelativePath(relativePath);
    const candidate = path.join(this.root, ...normalized.split('/'));
    let cursor = path.dirname(candidate);
    while (true) {
      try {
        const resolvedAncestor = await realpath(cursor);
        this.#assertInside(resolvedAncestor);
        this.#assertNotGit(resolvedAncestor);
        break;
      } catch (error) {
        if (error instanceof ExecutorError) throw error;
        const parent = path.dirname(cursor);
        if (parent === cursor) {
          throw new ExecutorError('PATH_ESCAPE', `Yazma yolu workspace dışına çıkıyor: ${normalized}`, {
            cause: error instanceof Error ? error.message : String(error),
          });
        }
        cursor = parent;
      }
    }
    try {
      const existing = await realpath(candidate);
      this.#assertInside(existing);
      this.#assertNotGit(existing);
    } catch (error) {
      if (error instanceof ExecutorError) throw error;
      // Missing targets are expected. Their nearest existing ancestor was checked above.
    }
    return candidate;
  }

  async readText(relativePath: string, offset = 0, limit = 1_048_576): Promise<string> {
    const resolved = await this.resolveExisting(relativePath);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit <= 0 || limit > 1_048_576) {
      throw new ExecutorError('INVALID_ARGUMENTS', 'Dosya okuma aralığı geçersiz');
    }
    const handle = await open(resolved, 'r');
    try {
      const buffer = Buffer.alloc(limit);
      const { bytesRead } = await handle.read(buffer, 0, limit, offset);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  }

  async atomicWrite(
    relativePath: string,
    content: string,
    beforeRename?: () => Promise<void>,
  ): Promise<void> {
    const requestedDestination = await this.resolveForWrite(relativePath);
    await mkdir(path.dirname(requestedDestination), { recursive: true });
    const parent = await realpath(path.dirname(requestedDestination));
    this.#assertInside(parent);
    this.#assertNotGit(parent);
    const destination = path.join(parent, path.basename(requestedDestination));
    const parentChain = await this.#snapshotDirectoryChain(parent);
    const parentHandle = await open(
      parent,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    const expectedParent = parentChain.at(-1);
    const temporary = path.join(
      parent,
      `.ww-${path.basename(destination)}-${randomUUID()}.tmp`,
    );
    let handle: FileHandle | undefined;
    let temporaryIdentity: FileIdentity | undefined;
    let renamed = false;
    try {
      if (expectedParent === undefined) throw this.#pathChanged();
      await this.#revalidateParent(parentChain, parentHandle);
      const destinationSnapshot = await this.#snapshotDestination(destination);
      await this.#revalidateParent(parentChain, parentHandle);
      const mode = destinationSnapshot.exists ? destinationSnapshot.mode : 0o644;
      handle = await open(temporary, 'wx', mode);
      temporaryIdentity = identityOf(await handle.stat({ bigint: true }));
      await handle.writeFile(content, 'utf8');
      await handle.sync();
      await handle.close();
      await beforeRename?.();
      await this.#revalidateParent(parentChain, parentHandle);
      await this.#revalidateDestination(destination, destinationSnapshot);
      await this.#revalidateParent(parentChain, parentHandle);
      await rename(temporary, destination);
      renamed = true;
    } finally {
      await handle?.close().catch(() => undefined);
      if (!renamed && temporaryIdentity !== undefined && expectedParent !== undefined) {
        await this.#cleanupTemporary(
          path.basename(temporary),
          temporaryIdentity,
          expectedParent.identity,
          parentChain[0]?.identity,
        ).catch(() => undefined);
      }
      await parentHandle.close().catch(() => undefined);
    }
  }

  async editText(
    relativePath: string,
    oldText: string,
    newText: string,
    beforeRename?: () => Promise<void>,
  ): Promise<void> {
    const resolved = await this.resolveExisting(relativePath);
    const info = await stat(resolved);
    if (!info.isFile() || info.size > 4_194_304) {
      throw new ExecutorError('INVALID_ARGUMENTS', 'edit_file en fazla 4 MiB normal dosyada çalışır');
    }
    const content = await readFile(resolved, 'utf8');
    const first = content.indexOf(oldText);
    const second = first < 0 ? -1 : content.indexOf(oldText, first + oldText.length);
    if (first < 0 || second >= 0) {
      throw new ExecutorError(
        'EDIT_MISMATCH',
        first < 0 ? 'edit_file old metni bulunamadı' : 'edit_file old metni tekil değil',
      );
    }
    const updated = `${content.slice(0, first)}${newText}${content.slice(first + oldText.length)}`;
    await this.atomicWrite(relativePath, updated, beforeRename);
  }

  async #ensureInitialized(): Promise<void> {
    if (this.#rootReal === undefined) await this.initialize();
  }

  async #snapshotDirectoryChain(parent: string): Promise<readonly DirectorySnapshot[]> {
    const relative = path.relative(this.root, parent);
    if (!isInside(this.root, parent)) throw this.#pathChanged();
    const paths = [this.root];
    if (relative !== '') {
      let cursor = this.root;
      for (const segment of relative.split(path.sep)) {
        cursor = path.join(cursor, segment);
        paths.push(cursor);
      }
    }
    const snapshots: DirectorySnapshot[] = [];
    for (const candidate of paths) {
      this.#assertNotGit(candidate);
      const info = await lstat(candidate, { bigint: true });
      if (info.isSymbolicLink() || !info.isDirectory()) throw this.#pathChanged();
      snapshots.push({ path: candidate, identity: identityOf(info) });
    }
    return snapshots;
  }

  async #snapshotDestination(destination: string): Promise<DestinationSnapshot> {
    let before: BigIntStats;
    try {
      before = await lstat(destination, { bigint: true });
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return { exists: false };
      throw error;
    }
    let resolved: string;
    try {
      resolved = await realpath(destination);
    } catch (error) {
      throw this.#pathChanged(error);
    }
    this.#assertInside(resolved);
    this.#assertNotGit(resolved);
    const after = await lstat(destination, { bigint: true });
    if (
      before.isSymbolicLink()
      || !before.isFile()
      || !hasIdentity(after, identityOf(before))
      || after.isSymbolicLink()
      || !after.isFile()
    ) {
      throw this.#pathChanged();
    }
    return {
      exists: true,
      identity: identityOf(after),
      mode: Number(after.mode & 0o777n),
      realPath: resolved,
    };
  }

  async #revalidateParent(
    expectedChain: readonly DirectorySnapshot[],
    parentHandle: FileHandle,
  ): Promise<void> {
    const expectedParent = expectedChain.at(-1);
    if (expectedParent === undefined) throw this.#pathChanged();
    let resolved: string;
    try {
      resolved = await realpath(expectedParent.path);
    } catch (error) {
      throw this.#pathChanged(error);
    }
    this.#assertInside(resolved);
    this.#assertNotGit(resolved);
    if (resolved !== expectedParent.path) throw this.#pathChanged();

    for (const expected of expectedChain) {
      let current: BigIntStats;
      try {
        current = await lstat(expected.path, { bigint: true });
      } catch (error) {
        throw this.#pathChanged(error);
      }
      if (
        current.isSymbolicLink()
        || !current.isDirectory()
        || !hasIdentity(current, expected.identity)
      ) {
        throw this.#pathChanged();
      }
    }

    const pinned = await parentHandle.stat({ bigint: true });
    const finalParent = await lstat(expectedParent.path, { bigint: true });
    if (
      !hasIdentity(pinned, expectedParent.identity)
      || !hasIdentity(finalParent, expectedParent.identity)
      || finalParent.isSymbolicLink()
      || !finalParent.isDirectory()
    ) {
      throw this.#pathChanged();
    }
  }

  async #revalidateDestination(
    destination: string,
    expected: DestinationSnapshot,
  ): Promise<void> {
    const current = await this.#snapshotDestination(destination);
    if (current.exists !== expected.exists) throw this.#pathChanged();
    if (!current.exists || !expected.exists) return;
    if (
      !identitiesEqual(current.identity, expected.identity)
      || current.realPath !== expected.realPath
    ) {
      throw this.#pathChanged();
    }
  }

  async #cleanupTemporary(
    temporaryName: string,
    expectedTemporary: FileIdentity,
    expectedParent: FileIdentity,
    expectedRoot: FileIdentity | undefined,
  ): Promise<void> {
    if (expectedRoot === undefined) return;
    const parent = await this.#findSafeDirectory(expectedParent, expectedRoot);
    if (parent === undefined) return;
    const temporary = path.join(parent, temporaryName);
    const before = await lstat(temporary, { bigint: true });
    if (!before.isFile() || !hasIdentity(before, expectedTemporary)) return;
    const resolvedParent = await realpath(parent);
    this.#assertInside(resolvedParent);
    this.#assertNotGit(resolvedParent);
    if (resolvedParent !== parent) return;
    const after = await lstat(temporary, { bigint: true });
    if (!after.isFile() || !hasIdentity(after, expectedTemporary)) return;
    const finalParent = await lstat(parent, { bigint: true });
    if (
      finalParent.isSymbolicLink()
      || !finalParent.isDirectory()
      || !hasIdentity(finalParent, expectedParent)
    ) {
      return;
    }
    await unlink(temporary);
  }

  async #findSafeDirectory(
    expectedDirectory: FileIdentity,
    expectedRoot: FileIdentity,
  ): Promise<string | undefined> {
    const currentRoot = await lstat(this.root, { bigint: true });
    if (
      currentRoot.isSymbolicLink()
      || !currentRoot.isDirectory()
      || !hasIdentity(currentRoot, expectedRoot)
    ) {
      return undefined;
    }
    const queue = [this.root];
    let visited = 0;
    while (queue.length > 0 && visited < MAX_CLEANUP_DIRECTORIES) {
      const candidate = queue.shift();
      if (candidate === undefined) break;
      visited += 1;
      let info: BigIntStats;
      try {
        info = await lstat(candidate, { bigint: true });
      } catch {
        continue;
      }
      if (info.isSymbolicLink() || !info.isDirectory()) continue;
      if (hasIdentity(info, expectedDirectory)) return candidate;
      let entries: Dirent[];
      try {
        entries = await readdir(candidate, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.toLowerCase() === '.git') continue;
        queue.push(path.join(candidate, entry.name));
      }
    }
    return undefined;
  }

  #pathChanged(cause?: unknown): ExecutorError {
    return new ExecutorError('PATH_INVALID', 'Yazma yolu işlem sırasında değişti; güvenli yazma reddedildi', {
      ...(cause === undefined ? {} : { cause: cause instanceof Error ? cause.message : String(cause) }),
    });
  }

  #assertInside(candidate: string): void {
    if (!isInside(this.root, candidate)) {
      throw new ExecutorError('PATH_ESCAPE', 'Çözümlenen yol workspace dışına çıkıyor');
    }
  }

  #assertNotGit(candidate: string): void {
    const workspaceRelative = path.relative(this.root, candidate);
    const hasGitSegment = isInside(this.root, candidate)
      && workspaceRelative.split(path.sep).some((segment) => segment.toLowerCase() === '.git');
    if (hasGitSegment || (this.#gitReal !== undefined && isInside(this.#gitReal, candidate))) {
      throw new ExecutorError('PATH_INVALID', '.git gerçek-yol takma adı yalnız GitWorkspace üzerinden yönetilir');
    }
  }
}
