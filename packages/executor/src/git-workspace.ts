import { cp, lstat, mkdir, mkdtemp, readdir, readlink, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EntityIdSchema,
  TASK_STATUSES,
  canonicalSha256V1,
  type EntityId,
  type TaskStatus,
} from '@ww/shared';
import { ExecutorError } from './errors.js';
import { GateRunner, type GateEvidence } from './gate-runner.js';
import type {
  ExecutorAccessInput,
  ExecutorAccessPort,
  ExecutorHostCommandPort,
  ExecutorHostCommandResult,
} from './ports.js';
import { WorkspacePaths, normalizeWorkspaceRelativePath } from './workspace-paths.js';

export interface TaskCommitInput {
  readonly projectKey: string;
  readonly operationId: EntityId;
  readonly occurredAt: string;
  readonly taskId: EntityId;
  readonly title: string;
  readonly summary: string;
  readonly workerName: string;
  readonly verifierName: string;
  readonly targetFiles: readonly string[];
  /** One current-attempt + file-lock fence for every normalized target. */
  readonly targetAccess: readonly ExecutorAccessInput[];
  readonly deadlineAt?: string;
}

export interface TaskCommitResult {
  readonly commitHash: string;
  readonly gate: GateEvidence | null;
  readonly reconciled: boolean;
  readonly targetFingerprint: string;
}

export interface GitDiffResult {
  readonly diff: string;
  readonly truncated: boolean;
}

export interface StarterInitializationInput {
  readonly operationId: EntityId;
  readonly occurredAt: string;
}

export interface StarterInitializationResult {
  readonly workspaceRoot: string;
  readonly commitHash: string;
  readonly gate: GateEvidence | null;
  readonly reconciled: boolean;
  readonly requestHash: string;
  readonly targetFingerprint: string;
}

interface CommitScope {
  readonly projectId: EntityId;
  readonly taskId: EntityId;
  readonly taskBriefId: EntityId;
  readonly assignmentAttemptId: EntityId;
  readonly agentId: EntityId;
  readonly taskStatus: TaskStatus;
  readonly leaseOwner: string;
  readonly leaseFence: number;
}

interface ValidatedCommitInput {
  readonly taskId: EntityId;
  readonly operationId: EntityId;
  readonly projectKey: string;
  readonly occurredAt: string;
  readonly title: string;
  readonly summary: string;
  readonly workerName: string;
  readonly verifierName: string;
  readonly targets: readonly string[];
  readonly access: readonly ExecutorAccessInput[];
  readonly scope: CommitScope;
}

interface IndexEntry {
  readonly mode: string;
  readonly objectId: string;
}

const mutationQueues = new Map<string, Promise<void>>();

async function serializedMutation<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  mutationQueues.set(key, tail);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (mutationQueues.get(key) === tail) mutationQueues.delete(key);
  }
}

function commandFailure(action: string, result: ExecutorHostCommandResult): ExecutorError {
  const code = result.timedOut ? 'COMMAND_TIMEOUT' : 'GIT_FAILED';
  return new ExecutorError(code, `${action} başarısız oldu`, {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    truncated: result.truncated,
  });
}

function assertGitSuccess(action: string, result: ExecutorHostCommandResult): ExecutorHostCommandResult {
  if (result.exitCode !== 0 || result.timedOut) throw commandFailure(action, result);
  return result;
}

function assertIso(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new ExecutorError('INVALID_ARGUMENTS', 'occurredAt canonical ISO-8601 olmalıdır');
  }
  return value;
}

function validatedCommitInput(input: TaskCommitInput): ValidatedCommitInput {
  const taskId = EntityIdSchema.parse(input.taskId);
  const operationId = EntityIdSchema.parse(input.operationId);
  const occurredAt = assertIso(input.occurredAt);
  const projectKey = input.projectKey;
  if (projectKey.trim().length === 0 || projectKey.length > 8_192 || projectKey.includes('\0')) {
    throw new ExecutorError('INVALID_ARGUMENTS', 'projectKey geçersiz');
  }
  const title = input.title.trim();
  if (title.length === 0 || title.length > 120 || title.includes('\n') || title.includes('\r')) {
    throw new ExecutorError('INVALID_ARGUMENTS', 'Commit başlığı tek satır ve en fazla 120 karakter olmalıdır');
  }
  const summary = input.summary.trim();
  const workerName = input.workerName.trim();
  const verifierName = input.verifierName.trim();
  for (const [label, value] of [
    ['summary', summary], ['workerName', workerName], ['verifierName', verifierName],
  ] as const) {
    if (
      value.trim().length === 0 || value.length > 8_192 || value.includes('\0') ||
      /(?:^|\n)WW-[A-Za-z-]+:/.test(value)
    ) {
      throw new ExecutorError('INVALID_ARGUMENTS', `${label} geçersiz`);
    }
  }
  const targets = [...new Set(input.targetFiles.map(normalizeWorkspaceRelativePath))].sort();
  if (targets.length === 0) {
    throw new ExecutorError('TARGET_NOT_DECLARED', 'Task commit en az bir hedef dosya gerektirir');
  }
  if (input.targetAccess.length !== targets.length) {
    throw new ExecutorError('INVALID_ARGUMENTS', 'Her commit hedefi için exact access fence gerekir');
  }
  const access = input.targetAccess.map((item): ExecutorAccessInput => {
    if (!item.requireFileLock) {
      throw new ExecutorError('LOCK_REQUIRED', 'Commit hedeflerinin file lock doğrulaması zorunludur');
    }
    if (item.relativePath === undefined) {
      throw new ExecutorError('INVALID_ARGUMENTS', 'Commit access fence target yolu gerektirir');
    }
    const projectId = EntityIdSchema.parse(item.projectId);
    const accessTaskId = EntityIdSchema.parse(item.taskId);
    const taskBriefId = EntityIdSchema.parse(item.taskBriefId);
    const assignmentAttemptId = EntityIdSchema.parse(item.assignmentAttemptId);
    const agentId = EntityIdSchema.parse(item.agentId);
    if (!(TASK_STATUSES as readonly string[]).includes(item.taskStatus)) {
      throw new ExecutorError('INVALID_ARGUMENTS', 'Commit access task status geçersiz');
    }
    if (
      typeof item.leaseOwner !== 'string' || item.leaseOwner.trim().length === 0 ||
      item.leaseOwner.length > 8_192 || item.leaseOwner.includes('\0') ||
      !Number.isSafeInteger(item.leaseFence) || item.leaseFence <= 0
    ) {
      throw new ExecutorError('INVALID_ARGUMENTS', 'Commit access lease fence geçersiz');
    }
    return Object.freeze({
      projectId,
      taskId: accessTaskId,
      taskBriefId,
      assignmentAttemptId,
      agentId,
      taskStatus: item.taskStatus,
      leaseOwner: item.leaseOwner,
      leaseFence: item.leaseFence,
      relativePath: normalizeWorkspaceRelativePath(item.relativePath),
      requireFileLock: true,
    });
  });
  const first = access[0];
  if (first === undefined || first.taskId !== taskId) {
    throw new ExecutorError('INVALID_ARGUMENTS', 'Commit task scope access fence ile eşleşmiyor');
  }
  const scope: CommitScope = Object.freeze({
    projectId: first.projectId,
    taskId,
    taskBriefId: first.taskBriefId,
    assignmentAttemptId: first.assignmentAttemptId,
    agentId: first.agentId,
    taskStatus: first.taskStatus,
    leaseOwner: first.leaseOwner,
    leaseFence: first.leaseFence,
  });
  const sameScope = (item: ExecutorAccessInput): boolean =>
    item.projectId === scope.projectId && item.taskId === scope.taskId &&
    item.taskBriefId === scope.taskBriefId && item.assignmentAttemptId === scope.assignmentAttemptId &&
    item.agentId === scope.agentId && item.taskStatus === scope.taskStatus &&
    item.leaseOwner === scope.leaseOwner && item.leaseFence === scope.leaseFence;
  if (access.some((item) => !sameScope(item))) {
    throw new ExecutorError('INVALID_ARGUMENTS', 'Tüm commit access fence kayıtları aynı exact scope’a ait olmalıdır');
  }
  const accessTargets = access.map((item) => item.relativePath!).sort();
  if (accessTargets.some((item, index) => item !== targets[index])) {
    throw new ExecutorError('INVALID_ARGUMENTS', 'Her normalized commit hedefi için exact access fence gerekir');
  }
  return Object.freeze({
    taskId,
    operationId,
    projectKey,
    occurredAt,
    title,
    summary,
    workerName,
    verifierName,
    targets: Object.freeze(targets),
    access: Object.freeze(access),
    scope,
  });
}

export class GitWorkspace {
  readonly #runner: ExecutorHostCommandPort;
  readonly #gates: GateRunner;
  readonly #access: ExecutorAccessPort;

  constructor(commandRunner: ExecutorHostCommandPort, gateRunner: GateRunner, access: ExecutorAccessPort) {
    this.#runner = commandRunner;
    this.#gates = gateRunner;
    this.#access = access;
  }

  async diff(
    projectKey: string,
    workspace: WorkspacePaths,
    declaredTargets: readonly string[],
  ): Promise<GitDiffResult> {
    const targets = [...new Set(declaredTargets.map(normalizeWorkspaceRelativePath))].sort();
    if (targets.length === 0) return Object.freeze({ diff: '', truncated: false });
    const unstagedResult = assertGitSuccess('git diff', await this.#git(projectKey, workspace, [
      'diff', '--no-ext-diff', '--', ...targets,
    ]));
    const stagedResult = assertGitSuccess('git diff --cached', await this.#git(projectKey, workspace, [
      'diff', '--cached', '--no-ext-diff', '--', ...targets,
    ]));
    const untrackedResult = assertGitSuccess('git ls-files', await this.#git(projectKey, workspace, [
      'ls-files', '--others', '--exclude-standard', '-z', '--', ...targets,
    ]));
    const untrackedFiles = untrackedResult.stdout.split('\0').filter((item) => item.length > 0);
    const untrackedDiffs: string[] = [];
    let untrackedTruncated = untrackedFiles.length > 256;
    let untrackedBytes = 0;
    for (const relativePath of untrackedFiles.slice(0, 256)) {
      normalizeWorkspaceRelativePath(relativePath);
      const result = await this.#git(projectKey, workspace, [
        'diff', '--no-index', '--no-ext-diff', '--', '/dev/null', relativePath,
      ]);
      if (result.exitCode !== 0 && result.exitCode !== 1) throw commandFailure('git diff untracked', result);
      untrackedDiffs.push(result.stdout);
      untrackedBytes += Buffer.byteLength(result.stdout, 'utf8');
      untrackedTruncated ||= result.truncated;
      if (untrackedBytes > 1_048_576) { untrackedTruncated = true; break; }
    }
    const combined = [
      unstagedResult.stdout,
      stagedResult.stdout.length === 0 ? '' : `\n# Staged changes\n${stagedResult.stdout}`,
      untrackedDiffs.length === 0 ? '' : `\n# Untracked files\n${untrackedDiffs.join('')}`,
    ].join('');
    const bytes = Buffer.from(combined, 'utf8');
    return Object.freeze({
      diff: bytes.subarray(0, 1_048_576).toString('utf8'),
      truncated: unstagedResult.truncated || stagedResult.truncated || untrackedResult.truncated ||
        untrackedTruncated || bytes.byteLength > 1_048_576,
    });
  }

  async commitAfterSuccessfulGate(
    workspace: WorkspacePaths,
    input: TaskCommitInput,
  ): Promise<TaskCommitResult> {
    const validated = validatedCommitInput(input);
    await workspace.initialize();
    return await serializedMutation(workspace.root, async () => {
      for (const target of validated.targets) await workspace.resolveForWrite(target);
      await this.#assertAccess(validated.access);
      const fingerprint = await this.#targetFingerprint(
        validated.projectKey,
        workspace,
        validated.targets,
      );
      const requestHash = canonicalSha256V1({
        kind: 'task_commit_v1',
        projectKey: validated.projectKey,
        occurredAt: validated.occurredAt,
        projectId: validated.scope.projectId,
        taskId: validated.taskId,
        taskBriefId: validated.scope.taskBriefId,
        assignmentAttemptId: validated.scope.assignmentAttemptId,
        agentId: validated.scope.agentId,
        taskStatus: validated.scope.taskStatus,
        leaseOwner: validated.scope.leaseOwner,
        leaseFence: validated.scope.leaseFence,
        operationId: validated.operationId,
        title: validated.title,
        summary: validated.summary,
        workerName: validated.workerName,
        verifierName: validated.verifierName,
        targets: validated.targets,
        targetFingerprint: fingerprint,
      });
      const scopeHash = canonicalSha256V1(validated.scope);
      const targetsHash = canonicalSha256V1(validated.targets);
      const reconciled = await this.#reconcileTask(
        validated,
        workspace,
        requestHash,
        scopeHash,
        targetsHash,
        fingerprint,
      );
      if (reconciled !== null) {
        await this.#gates.audit.appendCommit({
          kind: 'task',
          projectKey: validated.projectKey,
          operationId: validated.operationId,
          occurredAt: validated.occurredAt,
          projectId: validated.scope.projectId,
          taskId: validated.taskId,
          taskBriefId: validated.scope.taskBriefId,
          assignmentAttemptId: validated.scope.assignmentAttemptId,
          agentId: validated.scope.agentId,
          taskStatus: validated.scope.taskStatus,
          leaseOwner: validated.scope.leaseOwner,
          leaseFence: validated.scope.leaseFence,
          targets: validated.targets,
          commitHash: reconciled.commitHash,
          reconciled: false,
          requestHash,
          targetFingerprint: reconciled.targetFingerprint,
        });
        return Object.freeze({ ...reconciled, gate: null, reconciled: true });
      }

      await this.#assertAccess(validated.access);
      await this.#assertFingerprint(validated.projectKey, workspace, validated.targets, fingerprint);
      const gate = await this.#gates.run(validated.projectKey, workspace, {
        operationId: validated.operationId,
        occurredAt: validated.occurredAt,
        ...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }),
      });
      if (!gate.passed) throw new ExecutorError('GATE_FAILED', 'Gate başarısız; commit oluşturulmadı', { gate });

      await this.#assertAccess(validated.access);
      await this.#assertFingerprint(validated.projectKey, workspace, validated.targets, fingerprint);
      const targetStatus = assertGitSuccess('git status', await this.#git(
        validated.projectKey, workspace,
        ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...validated.targets],
      )).stdout;
      if (targetStatus.length === 0) throw new ExecutorError('GIT_FAILED', 'Görev hedeflerinde commit edilecek değişiklik yok');

      const indexSnapshot = await this.#captureIndex(validated.projectKey, workspace, validated.targets);
      let indexTouched = false;
      let commitCreated = false;
      try {
        indexTouched = true;
        assertGitSuccess('git add', await this.#git(
          validated.projectKey, workspace, ['add', '--', ...validated.targets],
        ));
        await this.#assertAccess(validated.access);
        await this.#assertFingerprint(validated.projectKey, workspace, validated.targets, fingerprint);

        const shortId = validated.taskId.replaceAll('-', '').slice(0, 8);
        const subject = `task(${shortId}): ${validated.title}`;
        const body = `${validated.summary}\n\nWorker: ${validated.workerName}\nVerifier: ${validated.verifierName}` +
          `\nWW-Commit-Kind: task-v1\nWW-Operation-Id: ${validated.operationId}` +
          `\nWW-Request-Hash: ${requestHash}\nWW-Scope-Hash: ${scopeHash}` +
          `\nWW-Targets-Hash: ${targetsHash}\nWW-Target-Fingerprint: ${fingerprint}`;
        assertGitSuccess('git commit', await this.#git(
          validated.projectKey,
          workspace,
          ['commit', '--only', '-m', subject, '-m', body, '--', ...validated.targets],
        ));
        commitCreated = true;
        const commitHash = await this.#headHash(validated.projectKey, workspace);
        await this.#gates.audit.appendCommit({
          kind: 'task',
          projectKey: validated.projectKey,
          operationId: validated.operationId,
          occurredAt: validated.occurredAt,
          projectId: validated.scope.projectId,
          taskId: validated.taskId,
          taskBriefId: validated.scope.taskBriefId,
          assignmentAttemptId: validated.scope.assignmentAttemptId,
          agentId: validated.scope.agentId,
          taskStatus: validated.scope.taskStatus,
          leaseOwner: validated.scope.leaseOwner,
          leaseFence: validated.scope.leaseFence,
          targets: validated.targets,
          commitHash,
          reconciled: false,
          requestHash,
          targetFingerprint: fingerprint,
        });
        return Object.freeze({ commitHash, gate, reconciled: false, targetFingerprint: fingerprint });
      } catch (error) {
        if (indexTouched && !commitCreated) {
          try {
            await this.#restoreIndex(validated.projectKey, workspace, indexSnapshot);
          } catch (restoreError) {
            throw new ExecutorError('GIT_FAILED', 'Commit hatasından sonra target index state geri yüklenemedi', {
              cause: error instanceof Error ? error.message : String(error),
              restoreCause: restoreError instanceof Error ? restoreError.message : String(restoreError),
            });
          }
        }
        throw error;
      }
    });
  }

  async initializeWebStarter(
    destination: string,
    input: StarterInitializationInput,
  ): Promise<StarterInitializationResult> {
    const operationId = EntityIdSchema.parse(input.operationId);
    const occurredAt = assertIso(input.occurredAt);
    if (!path.isAbsolute(destination)) throw new ExecutorError('PATH_INVALID', 'Starter hedefi mutlak olmalıdır');
    const normalizedDestination = path.resolve(destination);
    const parent = path.dirname(normalizedDestination);
    await mkdir(parent, { recursive: true });
    const parentReal = await realpath(parent);
    const canonicalDestination = path.join(parentReal, path.basename(normalizedDestination));
    const destinationHash = canonicalSha256V1({ destination: canonicalDestination });
    return await serializedMutation(canonicalDestination, async () => {
      let destinationExisted = false;
      try {
        const info = await lstat(canonicalDestination);
        if (!info.isDirectory()) {
          throw new ExecutorError('WORKSPACE_NOT_EMPTY', 'Starter yalnız boş workspace içine kurulabilir');
        }
        if ((await readdir(canonicalDestination)).length !== 0) {
          const existingWorkspace = await new WorkspacePaths(canonicalDestination).initialize();
          const reconciled = await this.#reconcileStarter(
            canonicalDestination,
            existingWorkspace,
            operationId,
            occurredAt,
            destinationHash,
          );
          if (reconciled === null) {
            throw new ExecutorError('WORKSPACE_NOT_EMPTY', 'Starter yalnız boş workspace içine kurulabilir');
          }
          await this.#gates.audit.appendCommit({
            kind: 'starter',
            projectKey: canonicalDestination,
            operationId,
            occurredAt,
            commitHash: reconciled.commitHash,
            reconciled: false,
            destinationHash,
            requestHash: reconciled.requestHash,
            targetFingerprint: reconciled.targetFingerprint,
          });
          return Object.freeze({
            workspaceRoot: existingWorkspace.root,
            commitHash: reconciled.commitHash,
            gate: null,
            reconciled: true,
            requestHash: reconciled.requestHash,
            targetFingerprint: reconciled.targetFingerprint,
          });
        }
        destinationExisted = true;
      } catch (error) {
        if (error instanceof ExecutorError) throw error;
      }
      const stage = await mkdtemp(path.join(parentReal, `.ww-starter-${path.basename(canonicalDestination)}-`));
      const backup = `${stage}.destination-backup`;
      let published = false;
      let movedDestination = false;
      try {
        const template = fileURLToPath(new URL('../templates/web/', import.meta.url));
        await this.#assertCleanTemplate(template);
        for (const entry of await readdir(template)) {
          if (entry === '.gitignore') continue;
          await cp(path.join(template, entry), path.join(stage, entry), {
            recursive: true, errorOnExist: true, force: false,
          });
        }
        const packagedIgnore = path.join(stage, 'gitignore.template');
        await rename(packagedIgnore, path.join(stage, '.gitignore'));
        const workspace = await new WorkspacePaths(await realpath(stage)).initialize();
        assertGitSuccess('git init', await this.#git(canonicalDestination, workspace, ['init']));
        assertGitSuccess('git user.name', await this.#git(canonicalDestination, workspace, ['config', 'user.name', 'ww executor']));
        assertGitSuccess('git user.email', await this.#git(canonicalDestination, workspace, ['config', 'user.email', 'executor@ww.local']));
        const gate = await this.#gates.run(canonicalDestination, workspace, { operationId, occurredAt });
        if (!gate.passed) throw new ExecutorError('GATE_FAILED', 'Starter gate başarısız; başlangıç commit’i oluşturulmadı', { gate });
        assertGitSuccess('git add starter', await this.#git(canonicalDestination, workspace, ['add', '--all']));
        const treeHash = assertGitSuccess('git write-tree starter', await this.#git(
          canonicalDestination,
          workspace,
          ['write-tree'],
        )).stdout.trim();
        if (!/^[a-f0-9]{40,64}$/.test(treeHash)) {
          throw new ExecutorError('GIT_FAILED', 'Git starter tree hashini döndürmedi');
        }
        const targetFingerprint = canonicalSha256V1({ kind: 'starter_tree_v1', treeHash });
        const requestHash = this.#starterRequestHash(
          operationId,
          occurredAt,
          destinationHash,
          targetFingerprint,
        );
        const body = `WW-Commit-Kind: starter-v1\nWW-Operation-Id: ${operationId}` +
          `\nWW-Destination-Hash: ${destinationHash}\nWW-Request-Hash: ${requestHash}` +
          `\nWW-Target-Fingerprint: ${targetFingerprint}`;
        assertGitSuccess('git commit starter', await this.#git(
          canonicalDestination,
          workspace,
          ['commit', '-m', 'chore: initialize web starter', '-m', body],
        ));
        const commitHash = await this.#headHash(canonicalDestination, workspace);
        if (destinationExisted) { await rename(canonicalDestination, backup); movedDestination = true; }
        try {
          await rename(stage, canonicalDestination);
          published = true;
        } catch (error) {
          if (movedDestination) await rename(backup, canonicalDestination).catch(() => undefined);
          throw new ExecutorError('STARTER_PUBLISH_FAILED', 'Starter atomik yayınlanamadı', {
            cause: error instanceof Error ? error.message : String(error),
          });
        }
        if (movedDestination) await rm(backup, { recursive: true, force: true });
        await this.#gates.audit.appendCommit({
          kind: 'starter',
          projectKey: canonicalDestination,
          operationId,
          occurredAt,
          commitHash,
          reconciled: false,
          destinationHash,
          requestHash,
          targetFingerprint,
        });
        return Object.freeze({
          workspaceRoot: await realpath(canonicalDestination),
          commitHash,
          gate,
          reconciled: false,
          requestHash,
          targetFingerprint,
        });
      } finally {
        if (!published) await rm(stage, { recursive: true, force: true });
        if (!published && movedDestination) await rename(backup, canonicalDestination).catch(() => undefined);
      }
    });
  }

  async #assertAccess(checks: readonly ExecutorAccessInput[]): Promise<void> {
    for (const check of checks) await this.#access.assertAuthorized(check);
  }

  async #targetFingerprint(projectKey: string, workspace: WorkspacePaths, targets: readonly string[]): Promise<string> {
    const blobs: Array<{ path: string; mode: string; blob: string }> = [];
    for (const target of targets) {
      try {
        await workspace.resolveExisting(target);
        const candidate = await workspace.resolveForWrite(target);
        const info = await lstat(candidate);
        if (info.isSymbolicLink()) {
          blobs.push({
            path: target,
            mode: '120000',
            blob: canonicalSha256V1({ symlink: await readlink(candidate) }),
          });
          continue;
        }
        if (!info.isFile()) {
          throw new ExecutorError('GIT_CONFLICT', 'Commit hedefi normal dosya veya symlink olmalıdır');
        }
        const blob = assertGitSuccess('git hash-object', await this.#git(
          projectKey, workspace, ['hash-object', '--', target],
        )).stdout.trim();
        blobs.push({ path: target, mode: (info.mode & 0o111) === 0 ? '100644' : '100755', blob });
      } catch (error) {
        if (error instanceof ExecutorError && error.code === 'FILE_NOT_FOUND') {
          blobs.push({ path: target, mode: '000000', blob: '<missing>' });
        }
        else throw error;
      }
    }
    return canonicalSha256V1({ blobs });
  }

  async #assertFingerprint(
    projectKey: string, workspace: WorkspacePaths, targets: readonly string[], expected: string,
  ): Promise<void> {
    const actual = await this.#targetFingerprint(projectKey, workspace, targets);
    if (actual !== expected) throw new ExecutorError('GIT_CONFLICT', 'Hedefler pre-gate fingerprint sonrası değişti');
  }

  async #assertTargetsClean(
    projectKey: string,
    workspace: WorkspacePaths,
    targets: readonly string[],
  ): Promise<void> {
    const status = assertGitSuccess('git status reconciliation', await this.#git(
      projectKey,
      workspace,
      ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...targets],
    )).stdout;
    if (status.length !== 0) {
      throw new ExecutorError('GIT_CONFLICT', 'Reconcile edilen commit hedefleri current workspace’te dirty');
    }
  }

  #marker(body: string, name: string): string | undefined {
    const prefix = `${name}: `;
    const values = body.split('\n')
      .filter((line) => line.startsWith(prefix))
      .map((line) => line.slice(prefix.length).trim());
    // Executor metadata is appended after user-controlled summary/name text.
    return values.at(-1);
  }

  async #findOperationCommit(
    projectKey: string,
    workspace: WorkspacePaths,
    operationId: EntityId,
  ): Promise<{ commitHash: string; body: string } | null> {
    const marker = `WW-Operation-Id: ${operationId}`;
    const found = assertGitSuccess('git log reconciliation', await this.#git(projectKey, workspace, [
      'log', '--all', '--fixed-strings', `--grep=${marker}`, '--format=%H', '-n', '2',
    ])).stdout.trim().split('\n').filter(Boolean);
    if (found.length === 0) return null;
    if (found.length !== 1 || !/^[a-f0-9]{40,64}$/.test(found[0]!)) {
      throw new ExecutorError('GIT_CONFLICT', 'Operation id birden fazla commit ile eşleşti');
    }
    const body = assertGitSuccess('git show reconciliation', await this.#git(projectKey, workspace, [
      'show', '-s', '--format=%B', found[0]!,
    ])).stdout;
    return Object.freeze({ commitHash: found[0]!, body });
  }

  async #reconcileTask(
    validated: ValidatedCommitInput,
    workspace: WorkspacePaths,
    requestHash: string,
    scopeHash: string,
    targetsHash: string,
    fingerprint: string,
  ): Promise<{ commitHash: string; targetFingerprint: string } | null> {
    const found = await this.#findOperationCommit(
      validated.projectKey,
      workspace,
      validated.operationId,
    );
    if (found === null) return null;
    const targetFingerprint = this.#marker(found.body, 'WW-Target-Fingerprint');
    if (
      this.#marker(found.body, 'WW-Commit-Kind') !== 'task-v1' ||
      this.#marker(found.body, 'WW-Request-Hash') !== requestHash ||
      this.#marker(found.body, 'WW-Scope-Hash') !== scopeHash ||
      this.#marker(found.body, 'WW-Targets-Hash') !== targetsHash ||
      targetFingerprint !== fingerprint ||
      targetFingerprint === undefined
    ) {
      throw new ExecutorError('GIT_CONFLICT', 'Operation id farklı bir commit isteğine ait');
    }
    await this.#assertAccess(validated.access);
    await this.#assertTargetsClean(validated.projectKey, workspace, validated.targets);
    await this.#assertFingerprint(validated.projectKey, workspace, validated.targets, targetFingerprint);
    return Object.freeze({ commitHash: found.commitHash, targetFingerprint });
  }

  async #captureIndex(
    projectKey: string,
    workspace: WorkspacePaths,
    targets: readonly string[],
  ): Promise<ReadonlyMap<string, IndexEntry | null>> {
    const output = assertGitSuccess('git ls-files index snapshot', await this.#git(
      projectKey,
      workspace,
      ['ls-files', '--stage', '-z', '--', ...targets],
    )).stdout;
    const snapshot = new Map<string, IndexEntry | null>(targets.map((target) => [target, null]));
    for (const record of output.split('\0').filter(Boolean)) {
      const match = /^([0-7]{6}) ([a-f0-9]{40,64}) ([0-3])\t([\s\S]+)$/.exec(record);
      if (match === null || match[3] !== '0' || !snapshot.has(match[4]!)) {
        throw new ExecutorError('GIT_CONFLICT', 'Commit hedefi exact, conflict-free index dosyası olmalıdır');
      }
      if (snapshot.get(match[4]!) !== null) {
        throw new ExecutorError('GIT_CONFLICT', 'Commit hedefinin index kaydı tekil değil');
      }
      snapshot.set(match[4]!, Object.freeze({ mode: match[1]!, objectId: match[2]! }));
    }
    return snapshot;
  }

  async #restoreIndex(
    projectKey: string,
    workspace: WorkspacePaths,
    snapshot: ReadonlyMap<string, IndexEntry | null>,
  ): Promise<void> {
    for (const [target, entry] of snapshot) {
      if (entry === null) {
        assertGitSuccess('git restore new index entry', await this.#git(
          projectKey,
          workspace,
          ['update-index', '--force-remove', '--', target],
        ));
      } else {
        assertGitSuccess('git restore index entry', await this.#git(
          projectKey,
          workspace,
          ['update-index', '--add', '--cacheinfo', entry.mode, entry.objectId, target],
        ));
      }
    }
  }

  #starterRequestHash(
    operationId: EntityId,
    occurredAt: string,
    destinationHash: string,
    targetFingerprint: string,
  ): string {
    return canonicalSha256V1({
      kind: 'web_starter_v1',
      operationId,
      occurredAt,
      destinationHash,
      targetFingerprint,
    });
  }

  async #reconcileStarter(
    projectKey: string,
    workspace: WorkspacePaths,
    operationId: EntityId,
    occurredAt: string,
    destinationHash: string,
  ): Promise<{
    commitHash: string;
    requestHash: string;
    targetFingerprint: string;
  } | null> {
    let found: { commitHash: string; body: string } | null;
    try {
      found = await this.#findOperationCommit(projectKey, workspace, operationId);
    } catch (error) {
      if (error instanceof ExecutorError && error.code === 'GIT_FAILED') return null;
      throw error;
    }
    if (found === null) return null;
    const requestHash = this.#marker(found.body, 'WW-Request-Hash');
    const targetFingerprint = this.#marker(found.body, 'WW-Target-Fingerprint');
    if (
      this.#marker(found.body, 'WW-Commit-Kind') !== 'starter-v1' ||
      this.#marker(found.body, 'WW-Destination-Hash') !== destinationHash ||
      requestHash === undefined ||
      targetFingerprint === undefined
    ) {
      throw new ExecutorError('GIT_CONFLICT', 'Starter operation id farklı bir init isteğine ait');
    }
    const head = await this.#headHash(projectKey, workspace);
    if (head !== found.commitHash) {
      throw new ExecutorError('GIT_CONFLICT', 'Starter reconcile commit’i current HEAD değil');
    }
    const status = assertGitSuccess('git status starter reconciliation', await this.#git(
      projectKey,
      workspace,
      ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'],
    )).stdout;
    if (status.length !== 0) {
      throw new ExecutorError('GIT_CONFLICT', 'Starter reconcile workspace’i dirty');
    }
    const treeHash = assertGitSuccess('git tree starter reconciliation', await this.#git(
      projectKey,
      workspace,
      ['rev-parse', 'HEAD^{tree}'],
    )).stdout.trim();
    const currentFingerprint = canonicalSha256V1({ kind: 'starter_tree_v1', treeHash });
    const expectedRequest = this.#starterRequestHash(
      operationId,
      occurredAt,
      destinationHash,
      currentFingerprint,
    );
    if (targetFingerprint !== currentFingerprint || requestHash !== expectedRequest) {
      throw new ExecutorError('GIT_CONFLICT', 'Starter reconcile fingerprint veya request farklı');
    }
    return Object.freeze({ commitHash: found.commitHash, requestHash, targetFingerprint });
  }

  async #headHash(projectKey: string, workspace: WorkspacePaths): Promise<string> {
    const hash = assertGitSuccess('git rev-parse', await this.#git(projectKey, workspace, ['rev-parse', 'HEAD'])).stdout.trim();
    if (!/^[a-f0-9]{40,64}$/.test(hash)) throw new ExecutorError('GIT_FAILED', 'Git beklenen commit hashini döndürmedi');
    return hash;
  }

  async #assertCleanTemplate(root: string): Promise<void> {
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const lower = entry.name.toLocaleLowerCase('en-US');
        if (lower === '.git' || lower === 'node_modules' || lower === 'dist' || lower.startsWith('.env')) {
          throw new ExecutorError('PATH_INVALID', `Packaged starter yasaklı içerik barındırıyor: ${entry.name}`);
        }
        const absolute = path.join(directory, entry.name);
        const info = await lstat(absolute);
        if (info.isSymbolicLink()) throw new ExecutorError('PATH_INVALID', 'Packaged starter symlink içeremez');
        if (info.isDirectory()) await walk(absolute);
      }
    };
    await walk(root);
  }

  async #git(
    projectKey: string,
    workspace: WorkspacePaths,
    args: readonly string[],
  ): Promise<ExecutorHostCommandResult> {
    return await this.#runner.run({ projectKey, command: 'git', args, cwd: workspace.root, timeoutMs: 120_000 });
  }
}
