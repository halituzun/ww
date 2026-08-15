import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { TextDecoder } from 'node:util';

export type SandboxErrorCode =
  | 'SANDBOX_ABORTED'
  | 'SANDBOX_CLEANUP_FAILED'
  | 'SANDBOX_INPUT_TOO_LARGE'
  | 'SANDBOX_INVALID_ARGUMENT'
  | 'SANDBOX_SCOPE_VIOLATION'
  | 'SANDBOX_TIMEOUT'
  | 'SANDBOX_UNAVAILABLE';

export class SandboxError extends Error {
  constructor(
    readonly code: SandboxErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'SandboxError';
  }
}

export interface SandboxInputFile {
  readonly path: string;
  readonly content: string;
  readonly sha256: string;
}

export interface SandboxBaseHash {
  readonly path: string;
  readonly sha256: string;
}

export interface SandboxMutation {
  readonly path: string;
  readonly content: string;
  readonly sha256: string;
}

export interface SandboxPipelineStep {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
}

export interface SandboxPipelineInput {
  readonly callId: string;
  readonly projectId: string;
  /** Exact content-addressed capability inputs. The adapter never reads workspaceRoot. */
  readonly inputFiles: readonly SandboxInputFile[];
  readonly declaredTargets: readonly string[];
  /** Generated paths that are discarded with the container, such as node_modules/dist. */
  readonly discardedOutputs?: readonly string[];
  readonly steps: readonly SandboxPipelineStep[];
  readonly deadlineAt?: string;
  readonly signal?: AbortSignal;
}

export interface SandboxStepResult {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly durationMs: number;
}

export interface SandboxPipelineResult {
  readonly baseHashes: readonly SandboxBaseHash[];
  readonly steps: readonly SandboxStepResult[];
  readonly mutations: readonly SandboxMutation[];
}

export interface SandboxCommandInput extends Omit<SandboxPipelineInput, 'steps'> {
  readonly command: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
}

export interface SandboxCommandResult extends SandboxStepResult {
  readonly baseHashes: readonly SandboxBaseHash[];
  readonly mutations: readonly SandboxMutation[];
}

export interface SandboxPort {
  run(input: SandboxCommandInput): Promise<SandboxCommandResult>;
  runPipeline(input: SandboxPipelineInput): Promise<SandboxPipelineResult>;
}

export interface DockerProcessInput {
  readonly executable: 'docker';
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly containerName: string;
  readonly signal?: AbortSignal;
}

export interface DockerProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly durationMs: number;
}

export interface DockerProcessPort {
  run(input: DockerProcessInput): Promise<DockerProcessResult>;
  killContainer(containerName: string, env: Readonly<Record<string, string>>): Promise<void>;
}

export interface DockerSandboxOptions {
  readonly image: string;
  readonly processPort?: DockerProcessPort;
  readonly tempRoot?: string;
  readonly hostEnv?: NodeJS.ProcessEnv;
  readonly networkMode?: 'none' | 'bridge';
  readonly containerUser?: `${number}:${number}`;
  readonly pidsLimit?: number;
  readonly memory?: string;
  readonly cpus?: number;
  readonly workspaceSize?: string;
  readonly tempSize?: string;
  readonly maxOutputBytes?: number;
  readonly maxInputBytes?: number;
  readonly maxInputFiles?: number;
  readonly maxMutationBytes?: number;
  readonly cleanupTimeoutMs?: number;
}

interface FileSnapshot {
  readonly hash: string;
  readonly size: number;
}

const COMMAND_PATTERN = /^[A-Za-z0-9._+-]+$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const FORBIDDEN_SEGMENTS = new Set(['.git', 'secrets']);

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function isForbiddenSegment(value: string): boolean {
  const lower = value.toLocaleLowerCase('en-US');
  return FORBIDDEN_SEGMENTS.has(lower) || lower === '.env' || lower.startsWith('.env.');
}

function normalizeRelative(input: string): string {
  if (input.length === 0 || input.includes('\0') || path.isAbsolute(input) || path.win32.isAbsolute(input)) {
    throw new SandboxError('SANDBOX_INVALID_ARGUMENT', 'Sandbox path must be relative');
  }
  const portable = input.replaceAll('\\', '/');
  const segments = portable.split('/');
  if (segments.some((segment) => segment === '..' || isForbiddenSegment(segment))) {
    throw new SandboxError('SANDBOX_INVALID_ARGUMENT', 'Sandbox path contains a forbidden segment');
  }
  const normalized = path.posix.normalize(portable).replace(/^\.\//, '');
  if (normalized === '.' || normalized.length === 0 || normalized.startsWith('../')) {
    throw new SandboxError('SANDBOX_INVALID_ARGUMENT', 'Sandbox path must identify a file or directory');
  }
  return normalized;
}

function normalizeSnapshotRelative(input: string): string {
  if (input.length === 0 || input.includes('\0') || path.isAbsolute(input) || path.win32.isAbsolute(input)) {
    throw new SandboxError('SANDBOX_SCOPE_VIOLATION', 'Sandbox snapshot path must be relative');
  }
  const portable = input.replaceAll('\\', '/');
  const segments = portable.split('/');
  if (segments.some((segment) => segment === '..')) {
    throw new SandboxError('SANDBOX_SCOPE_VIOLATION', 'Sandbox snapshot path escaped');
  }
  const normalized = path.posix.normalize(portable).replace(/^\.\//, '');
  if (normalized === '.' || normalized.length === 0 || normalized.startsWith('../')) {
    throw new SandboxError('SANDBOX_SCOPE_VIOLATION', 'Sandbox snapshot path was invalid');
  }
  return normalized;
}

function matchesPrefix(relativePath: string, prefixes: ReadonlySet<string>): boolean {
  for (const prefix of prefixes) {
    if (relativePath === prefix || relativePath.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new SandboxError('SANDBOX_INVALID_ARGUMENT', `${label} must be a positive integer`);
  }
  return value;
}

function assertDockerSize(value: string, label: string): string {
  if (!/^\d+(?:[kmg])?$/i.test(value)) {
    throw new SandboxError('SANDBOX_INVALID_ARGUMENT', `${label} must be a Docker byte value`);
  }
  return value;
}

function minimalDockerEnv(source: NodeJS.ProcessEnv): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  if (source.PATH !== undefined) result.PATH = source.PATH;
  if (source.DOCKER_HOST !== undefined) result.DOCKER_HOST = source.DOCKER_HOST;
  return Object.freeze(result);
}

function effectiveTimeout(timeoutMs: number, deadlineAt?: string): number {
  positiveInteger(timeoutMs, 'timeoutMs');
  if (deadlineAt === undefined) return timeoutMs;
  const deadline = Date.parse(deadlineAt);
  if (!Number.isFinite(deadline)) throw new SandboxError('SANDBOX_INVALID_ARGUMENT', 'deadlineAt is invalid');
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new SandboxError('SANDBOX_TIMEOUT', 'Sandbox deadline expired');
  return Math.min(timeoutMs, remaining);
}

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function containerName(callId: string): string {
  return `ww-sandbox-${sha256(callId).slice(0, 32)}`;
}

async function writeInputs(
  root: string,
  files: readonly SandboxInputFile[],
  maxBytes: number,
  maxFiles: number,
): Promise<ReadonlyMap<string, FileSnapshot>> {
  if (files.length > maxFiles) {
    throw new SandboxError('SANDBOX_INPUT_TOO_LARGE', 'Sandbox inputs exceed file count limit', {
      count: files.length,
      limit: maxFiles,
    });
  }
  const result = new Map<string, FileSnapshot>();
  let bytes = 0;
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    const relativePath = normalizeRelative(file.path);
    const content = Buffer.from(file.content, 'utf8');
    const hash = sha256(content);
    if (!HASH_PATTERN.test(file.sha256) || file.sha256 !== hash || result.has(relativePath)) {
      throw new SandboxError('SANDBOX_INVALID_ARGUMENT', 'Sandbox inputs must be unique and content-addressed');
    }
    bytes += content.byteLength;
    if (bytes > maxBytes) {
      throw new SandboxError('SANDBOX_INPUT_TOO_LARGE', 'Sandbox inputs exceed byte limit', {
        bytes,
        limit: maxBytes,
      });
    }
    const destination = path.join(root, ...relativePath.split('/'));
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o777 });
    await chmod(path.dirname(destination), 0o777);
    const handle = await open(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o666);
    try { await handle.writeFile(content); } finally { await handle.close(); }
    await chmod(destination, 0o666);
    result.set(relativePath, Object.freeze({ hash, size: content.byteLength }));
  }
  return result;
}

function parseSnapshot(
  value: string,
  maxBytes: number,
): {
  readonly files: ReadonlyMap<string, FileSnapshot>;
  readonly contents: ReadonlyMap<string, Buffer>;
  readonly forbidden: readonly string[];
} {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch {
    throw new SandboxError('SANDBOX_UNAVAILABLE', 'Trusted sandbox snapshot was not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SandboxError('SANDBOX_UNAVAILABLE', 'Trusted sandbox snapshot was not an object');
  }
  const record = parsed as Record<string, unknown>;
  if (record['version'] !== 1 || !Array.isArray(record['entries']) ||
    !Number.isSafeInteger(record['totalBytes']) || Number(record['totalBytes']) < 0 ||
    Number(record['totalBytes']) > maxBytes || record['entries'].length > 100_000) {
    throw new SandboxError('SANDBOX_SCOPE_VIOLATION', 'Trusted sandbox snapshot exceeded its contract');
  }
  const files = new Map<string, FileSnapshot>();
  const contents = new Map<string, Buffer>();
  const forbidden: string[] = [];
  let totalBytes = 0;
  for (const raw of record['entries']) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new SandboxError('SANDBOX_SCOPE_VIOLATION', 'Trusted sandbox snapshot entry was invalid');
    }
    const entry = raw as Record<string, unknown>;
    let relativePath: string;
    try {
      if (typeof entry['path'] !== 'string') throw new Error('path');
      relativePath = normalizeSnapshotRelative(entry['path']);
    } catch {
      throw new SandboxError('SANDBOX_SCOPE_VIOLATION', 'Trusted sandbox snapshot path was invalid');
    }
    if (files.has(relativePath) || forbidden.includes(relativePath)) {
      throw new SandboxError('SANDBOX_SCOPE_VIOLATION', 'Trusted sandbox snapshot path was duplicated');
    }
    if (entry['type'] === 'forbidden') {
      forbidden.push(relativePath);
      continue;
    }
    if (entry['type'] !== 'file' || typeof entry['content'] !== 'string' ||
      typeof entry['sha256'] !== 'string' || !HASH_PATTERN.test(entry['sha256']) ||
      !Number.isSafeInteger(entry['bytes']) || Number(entry['bytes']) < 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(entry['content'])) {
      throw new SandboxError('SANDBOX_SCOPE_VIOLATION', 'Trusted sandbox snapshot file was invalid');
    }
    const content = Buffer.from(entry['content'], 'base64');
    if (content.byteLength !== entry['bytes'] || sha256(content) !== entry['sha256']) {
      throw new SandboxError('SANDBOX_SCOPE_VIOLATION', 'Trusted sandbox snapshot hash was invalid');
    }
    totalBytes += content.byteLength;
    if (totalBytes > maxBytes) throw new SandboxError('SANDBOX_SCOPE_VIOLATION', 'Sandbox output exceeds byte limit');
    files.set(relativePath, Object.freeze({ hash: entry['sha256'], size: content.byteLength }));
    contents.set(relativePath, content);
  }
  if (totalBytes !== record['totalBytes']) {
    throw new SandboxError('SANDBOX_SCOPE_VIOLATION', 'Trusted sandbox snapshot byte count diverged');
  }
  return { files, contents, forbidden: Object.freeze(forbidden.sort()) };
}

class NodeDockerProcessPort implements DockerProcessPort {
  async run(input: DockerProcessInput): Promise<DockerProcessResult> {
    const startedAt = performance.now();
    const child = spawn(input.executable, [...input.args], {
      detached: process.platform !== 'win32',
      env: { ...input.env },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let capturedBytes = 0;
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const capture = (target: Buffer[], chunk: Buffer): void => {
      const remaining = input.maxOutputBytes - capturedBytes;
      if (remaining <= 0) { truncated = true; return; }
      const accepted = chunk.subarray(0, remaining);
      target.push(accepted);
      capturedBytes += accepted.byteLength;
      if (accepted.byteLength < chunk.byteLength) truncated = true;
    };
    child.stdout?.on('data', (chunk: Buffer) => capture(stdout, chunk));
    child.stderr?.on('data', (chunk: Buffer) => capture(stderr, chunk));
    const terminate = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch { /* exited */ }
    };
    const stop = (reason: 'abort' | 'timeout'): void => {
      if (settled) return;
      aborted = reason === 'abort';
      timedOut = reason === 'timeout';
      terminate('SIGTERM');
      void this.killContainer(input.containerName, input.env);
      const force = setTimeout(() => terminate('SIGKILL'), 250);
      force.unref();
    };
    const onAbort = (): void => stop('abort');
    input.signal?.addEventListener('abort', onAbort, { once: true });
    if (input.signal?.aborted === true) onAbort();
    const timeout = setTimeout(() => stop('timeout'), input.timeoutMs);
    timeout.unref();
    return await new Promise((resolve, reject) => {
      child.once('error', () => {
        settled = true;
        clearTimeout(timeout);
        reject(new SandboxError('SANDBOX_UNAVAILABLE', 'Docker process could not start'));
      });
      child.once('close', (exitCode, signal) => {
        settled = true;
        clearTimeout(timeout);
        input.signal?.removeEventListener('abort', onAbort);
        if (aborted) { reject(new SandboxError('SANDBOX_ABORTED', 'Sandbox command aborted')); return; }
        resolve(Object.freeze({
          exitCode, signal,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          timedOut, truncated,
          durationMs: Math.max(0, performance.now() - startedAt),
        }));
      });
    });
  }

  async killContainer(name: string, env: Readonly<Record<string, string>>): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('docker', ['rm', '--force', name], { env: { ...env }, shell: false, stdio: 'ignore' });
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error === undefined) resolve();
        else reject(error);
      };
      const timeout = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* exited */ }
        finish(new Error('Docker cleanup timed out'));
      }, 5_000);
      timeout.unref();
      child.once('error', () => finish(new Error('Docker cleanup could not start')));
      child.once('close', () => finish());
    });
  }
}

export class DockerSandboxAdapter implements SandboxPort {
  readonly #image: string;
  readonly #process: DockerProcessPort;
  readonly #tempRoot: string;
  readonly #hostEnv: Readonly<Record<string, string>>;
  readonly #networkMode: 'none' | 'bridge';
  readonly #containerUser: `${number}:${number}`;
  readonly #pidsLimit: number;
  readonly #memory: string;
  readonly #cpus: number;
  readonly #workspaceSize: string;
  readonly #tempSize: string;
  readonly #maxOutputBytes: number;
  readonly #maxInputBytes: number;
  readonly #maxInputFiles: number;
  readonly #maxMutationBytes: number;
  readonly #cleanupTimeoutMs: number;

  constructor(options: DockerSandboxOptions) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/:@+-]{0,511}$/.test(options.image)) {
      throw new SandboxError('SANDBOX_INVALID_ARGUMENT', 'Explicit Docker image is required');
    }
    this.#image = options.image;
    this.#process = options.processPort ?? new NodeDockerProcessPort();
    this.#tempRoot = path.resolve(options.tempRoot ?? os.tmpdir());
    if (this.#tempRoot.includes(',') || this.#tempRoot.includes('\0')) {
      throw new SandboxError('SANDBOX_INVALID_ARGUMENT', 'tempRoot contains a Docker delimiter');
    }
    this.#hostEnv = minimalDockerEnv(options.hostEnv ?? process.env);
    this.#networkMode = options.networkMode ?? 'none';
    const uid = process.getuid?.() ?? 65_532;
    const gid = process.getgid?.() ?? 65_532;
    this.#containerUser = options.containerUser ?? `${uid === 0 ? 65_532 : uid}:${gid === 0 ? 65_532 : gid}`;
    if (!/^\d+:\d+$/.test(this.#containerUser) || this.#containerUser.startsWith('0:') || this.#containerUser.endsWith(':0')) {
      throw new SandboxError('SANDBOX_INVALID_ARGUMENT', 'Container uid/gid must be non-root');
    }
    this.#pidsLimit = positiveInteger(options.pidsLimit ?? 256, 'pidsLimit');
    this.#memory = assertDockerSize(options.memory ?? '2g', 'memory');
    this.#cpus = positiveInteger(options.cpus ?? 2, 'cpus');
    this.#workspaceSize = assertDockerSize(options.workspaceSize ?? '512m', 'workspaceSize');
    this.#tempSize = assertDockerSize(options.tempSize ?? '512m', 'tempSize');
    this.#maxOutputBytes = positiveInteger(options.maxOutputBytes ?? 1_048_576, 'maxOutputBytes');
    this.#maxInputBytes = positiveInteger(options.maxInputBytes ?? 64 * 1_048_576, 'maxInputBytes');
    this.#maxInputFiles = positiveInteger(options.maxInputFiles ?? 4_096, 'maxInputFiles');
    this.#maxMutationBytes = positiveInteger(options.maxMutationBytes ?? 4 * 1_048_576, 'maxMutationBytes');
    this.#cleanupTimeoutMs = positiveInteger(options.cleanupTimeoutMs ?? 5_000, 'cleanupTimeoutMs');
  }

  async run(input: SandboxCommandInput): Promise<SandboxCommandResult> {
    const pipeline = await this.runPipeline({
      callId: input.callId,
      projectId: input.projectId,
      inputFiles: input.inputFiles,
      declaredTargets: input.declaredTargets,
      ...(input.discardedOutputs === undefined ? {} : { discardedOutputs: input.discardedOutputs }),
      steps: [{ name: 'command', command: input.command, args: input.args, timeoutMs: input.timeoutMs }],
      ...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const step = pipeline.steps[0];
    if (step === undefined) throw new SandboxError('SANDBOX_UNAVAILABLE', 'Sandbox returned no command result');
    return Object.freeze({ ...step, baseHashes: pipeline.baseHashes, mutations: pipeline.mutations });
  }

  async runPipeline(input: SandboxPipelineInput): Promise<SandboxPipelineResult> {
    if (input.callId.length === 0 || input.projectId.length === 0 || input.steps.length === 0 || input.steps.length > 32) {
      throw new SandboxError('SANDBOX_INVALID_ARGUMENT', 'Sandbox identity and steps are required');
    }
    if (isAborted(input.signal)) throw new SandboxError('SANDBOX_ABORTED', 'Sandbox command aborted');
    const declared = new Set(input.declaredTargets.map(normalizeRelative));
    const discarded = new Set((input.discardedOutputs ?? []).map(normalizeRelative));
    for (const target of declared) {
      if (matchesPrefix(target, discarded)) throw new SandboxError('SANDBOX_INVALID_ARGUMENT', 'Target cannot be discarded');
    }
    for (const step of input.steps) {
      if (step.name.trim().length === 0 || !COMMAND_PATTERN.test(step.command) ||
        step.args.some((argument) => argument.includes('\0'))) {
        throw new SandboxError('SANDBOX_INVALID_ARGUMENT', 'Sandbox step is invalid');
      }
      positiveInteger(step.timeoutMs, 'step.timeoutMs');
    }

    await mkdir(this.#tempRoot, { recursive: true });
    const temp = await mkdtemp(path.join(this.#tempRoot, 'ww-sandbox-'));
    const inputRoot = path.join(temp, 'input');
    await mkdir(inputRoot, { recursive: true, mode: 0o777 });
    const before = await writeInputs(inputRoot, input.inputFiles, this.#maxInputBytes, this.#maxInputFiles);
    const baseHashes: SandboxBaseHash[] = [...new Set([...before.keys(), ...declared])].sort().map((file) => ({
      path: file,
      sha256: before.get(file)?.hash ?? '<missing>',
    }));
    const name = containerName(input.callId);
    const infra = async (args: readonly string[], timeoutMs = 30_000): Promise<DockerProcessResult> => {
      const result = await this.#process.run({
        executable: 'docker', args, env: this.#hostEnv, timeoutMs,
        maxOutputBytes: this.#maxOutputBytes, containerName: name,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (result.exitCode !== 0 || result.timedOut) {
        throw new SandboxError(result.timedOut ? 'SANDBOX_TIMEOUT' : 'SANDBOX_UNAVAILABLE', 'Docker isolation lifecycle failed', {
          exitCode: result.exitCode,
          truncated: result.truncated,
        });
      }
      return result;
    };
    const stepResults: SandboxStepResult[] = [];
    try {
      await infra([
        'create', '--name', name, '--network', this.#networkMode, '--read-only',
        '--mount', `type=bind,source=${inputRoot},target=/input,readonly`,
        '--tmpfs', `/workspace:rw,exec,nosuid,nodev,mode=1777,size=${this.#workspaceSize}`,
        '--tmpfs', `/tmp:rw,noexec,nosuid,nodev,size=${this.#tempSize}`,
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
        '--pids-limit', String(this.#pidsLimit), '--memory', this.#memory, '--cpus', String(this.#cpus),
        '--user', this.#containerUser, '--workdir', '/workspace',
        '--env', 'CI=1', '--env', 'HOME=/tmp', '--env', 'NO_COLOR=1',
        '--entrypoint', 'sleep', this.#image, 'infinity',
      ]);
      await infra(['start', name]);
      await infra([
        'exec', '--workdir', '/workspace', name,
        'env', '-i', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        'cp', '-R', '/input/.', '/workspace/',
      ]);
      for (const step of input.steps) {
        if (isAborted(input.signal)) {
          throw new SandboxError('SANDBOX_ABORTED', 'Sandbox command aborted');
        }
        const timeoutMs = effectiveTimeout(step.timeoutMs, input.deadlineAt);
        const result = await this.#process.run({
          executable: 'docker',
          args: [
            'exec', '--workdir', '/workspace', name,
            'env', '-i', 'CI=1', 'HOME=/tmp', 'NO_COLOR=1',
            'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
            'node', '/opt/ww/run-step.mjs', step.command, ...step.args,
          ],
          env: this.#hostEnv,
          timeoutMs,
          maxOutputBytes: this.#maxOutputBytes,
          containerName: name,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        stepResults.push(Object.freeze({
          name: step.name, command: step.command, args: Object.freeze([...step.args]), ...result,
        }));
        if (result.timedOut) {
          throw new SandboxError('SANDBOX_TIMEOUT', 'Sandbox step timed out', {
            step: step.name,
            truncated: result.truncated,
          });
        }
        if (result.exitCode !== 0) break;
      }
      const snapshot = await this.#process.run({
        executable: 'docker',
        args: [
          'exec', '--workdir', '/workspace', name,
          'env', '-i', 'CI=1', 'HOME=/tmp', 'NO_COLOR=1',
          'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
          'node', '/opt/ww/snapshot.mjs',
          Buffer.from(JSON.stringify([...discarded].sort()), 'utf8').toString('base64url'),
          String(this.#maxInputBytes),
        ],
        env: this.#hostEnv,
        timeoutMs: 30_000,
        maxOutputBytes: Math.ceil(this.#maxInputBytes * 4 / 3) + 16_777_216,
        containerName: name,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (snapshot.timedOut) throw new SandboxError('SANDBOX_TIMEOUT', 'Sandbox snapshot timed out');
      if (snapshot.truncated || snapshot.exitCode === 42) {
        throw new SandboxError('SANDBOX_SCOPE_VIOLATION', 'Sandbox output exceeded snapshot limit');
      }
      if (snapshot.exitCode !== 0) {
        throw new SandboxError('SANDBOX_UNAVAILABLE', 'Trusted sandbox snapshot failed', {
          exitCode: snapshot.exitCode,
        });
      }
      const after = parseSnapshot(snapshot.stdout, this.#maxInputBytes);
      const allPaths = new Set([...before.keys(), ...after.files.keys()]);
      const changed = [...allPaths].filter((file) => before.get(file)?.hash !== after.files.get(file)?.hash).sort();
      const violations = [
        ...after.forbidden,
        ...changed.filter((file) => !declared.has(file)),
        ...changed.filter((file) => !after.files.has(file)),
      ];
      if (violations.length > 0) {
        throw new SandboxError('SANDBOX_SCOPE_VIOLATION', 'Sandbox changed files outside declared targets', {
          paths: Object.freeze([...new Set(violations)].sort()),
          changes: Object.freeze(changed.map((file) => Object.freeze({
            path: file,
            beforeHash: before.get(file)?.hash ?? '<missing>',
            afterHash: after.files.get(file)?.hash ?? '<missing>',
          }))),
        });
      }
      let mutationBytes = 0;
      const mutations: SandboxMutation[] = [];
      for (const file of changed) {
        const content = after.contents.get(file);
        if (content === undefined) {
          throw new SandboxError('SANDBOX_SCOPE_VIOLATION', 'Declared mutation disappeared from snapshot');
        }
        mutationBytes += content.byteLength;
        if (mutationBytes > this.#maxMutationBytes) {
          throw new SandboxError('SANDBOX_SCOPE_VIOLATION', 'Declared mutations exceed byte limit');
        }
        let text: string;
        try { text = UTF8_DECODER.decode(content); } catch {
          throw new SandboxError('SANDBOX_SCOPE_VIOLATION', 'Declared mutation must be UTF-8');
        }
        mutations.push(Object.freeze({ path: file, content: text, sha256: sha256(content) }));
      }
      return Object.freeze({
        baseHashes: Object.freeze(baseHashes),
        steps: Object.freeze(stepResults),
        mutations: Object.freeze(mutations),
      });
    } finally {
      let cleanupError: SandboxError | undefined;
      const cleanup = this.#process.killContainer(name, this.#hostEnv).then(
        () => true,
        () => false,
      );
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const completed = await Promise.race([
        cleanup,
        new Promise<false>((resolve) => {
          timeout = setTimeout(() => resolve(false), this.#cleanupTimeoutMs);
          timeout.unref();
        }),
      ]);
      if (timeout !== undefined) clearTimeout(timeout);
      if (!completed) {
        cleanupError = new SandboxError(
          'SANDBOX_CLEANUP_FAILED',
          'Sandbox container cleanup could not be confirmed',
        );
      }
      await rm(temp, { recursive: true, force: true });
      if (cleanupError !== undefined) throw cleanupError;
    }
  }
}
