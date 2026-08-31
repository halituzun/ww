import { spawn } from 'node:child_process';
import process from 'node:process';
import { ExecutorError } from './errors.js';
import {
  systemExecutorClock,
  type ExecutorClockPort,
  type ExecutorHostCommandInput,
  type ExecutorHostCommandPort,
  type ExecutorHostCommandResult,
} from './ports.js';

/** Host execution is Git-only by default. Project-controlled commands use SandboxPort. */
export const DEFAULT_HOST_COMMANDS = Object.freeze(['git'] as const);

export type CommandInput = ExecutorHostCommandInput;
export type CommandResult = ExecutorHostCommandResult;

export interface CommandRunnerOptions {
  readonly allowedCommands?: readonly string[];
  readonly maxConcurrentPerProject?: number;
  readonly defaultTimeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly clock?: ExecutorClockPort;
}

function minimalHostEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'CI', 'NO_COLOR',
    'SystemRoot', 'PATHEXT',
  ] as const) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ExecutorError('INVALID_ARGUMENTS', `${label} pozitif tam sayı olmalıdır`);
  }
}

export class CommandRunner implements ExecutorHostCommandPort {
  readonly #allowedCommands: ReadonlySet<string>;
  readonly #maxConcurrent: number;
  readonly #defaultTimeoutMs: number;
  readonly #maxOutputBytes: number;
  readonly #clock: ExecutorClockPort;
  readonly #activeByProject = new Map<string, number>();

  constructor(options: CommandRunnerOptions = {}) {
    this.#allowedCommands = new Set(options.allowedCommands ?? DEFAULT_HOST_COMMANDS);
    this.#maxConcurrent = options.maxConcurrentPerProject ?? 4;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 300_000;
    this.#maxOutputBytes = options.maxOutputBytes ?? 1_048_576;
    this.#clock = options.clock ?? systemExecutorClock;
    assertPositiveInteger(this.#maxConcurrent, 'maxConcurrentPerProject');
    assertPositiveInteger(this.#defaultTimeoutMs, 'defaultTimeoutMs');
    assertPositiveInteger(this.#maxOutputBytes, 'maxOutputBytes');
  }

  isAllowed(command: string): boolean {
    return this.#allowedCommands.has(command);
  }

  async run(input: CommandInput): Promise<CommandResult> {
    if (!/^[a-zA-Z0-9._+-]+$/.test(input.command) || !this.isAllowed(input.command)) {
      throw new ExecutorError('COMMAND_NOT_ALLOWED', `Komut izin listesinde değil: ${input.command}`);
    }
    if (input.args.some((argument) => typeof argument !== 'string' || argument.includes('\0'))) {
      throw new ExecutorError('INVALID_ARGUMENTS', 'Komut argümanları null byte içermeyen metin olmalıdır');
    }
    const active = this.#activeByProject.get(input.projectKey) ?? 0;
    if (active >= this.#maxConcurrent) {
      throw new ExecutorError('COMMAND_CONCURRENCY_LIMIT', 'Proje komut eşzamanlılık sınırına ulaştı');
    }
    this.#activeByProject.set(input.projectKey, active + 1);
    try {
      return await this.#spawn(input);
    } finally {
      const remaining = (this.#activeByProject.get(input.projectKey) ?? 1) - 1;
      if (remaining <= 0) this.#activeByProject.delete(input.projectKey);
      else this.#activeByProject.set(input.projectKey, remaining);
    }
  }

  async #spawn(input: CommandInput): Promise<CommandResult> {
    const requestedTimeout = input.timeoutMs ?? this.#defaultTimeoutMs;
    assertPositiveInteger(requestedTimeout, 'timeoutMs');
    const deadlineRemaining = input.deadlineAt === undefined
      ? requestedTimeout
      : Date.parse(input.deadlineAt) - Date.now();
    const timeoutMs = Math.min(requestedTimeout, deadlineRemaining);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new ExecutorError('COMMAND_TIMEOUT', 'Görev deadline süresi dolmuş');
    }

    const started = this.#clock.monotonicMs();
    const child = spawn(input.command, [...input.args], {
      cwd: input.cwd,
      detached: process.platform !== 'win32',
      env: {
        ...minimalHostEnvironment(process.env),
        ...(input.env ?? {}),
      },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let capturedBytes = 0;
    let truncated = false;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const capture = (target: Buffer[], chunk: Buffer): void => {
      const remaining = this.#maxOutputBytes - capturedBytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const accepted = chunk.subarray(0, remaining);
      target.push(accepted);
      capturedBytes += accepted.byteLength;
      if (accepted.byteLength < chunk.byteLength) truncated = true;
    };
    child.stdout?.on('data', (chunk: Buffer) => capture(stdoutChunks, chunk));
    child.stderr?.on('data', (chunk: Buffer) => capture(stderrChunks, chunk));

    let timedOut = false;
    const terminateTree = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch {
        // The child may already have exited between the close check and kill.
      }
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateTree('SIGTERM');
      const force = setTimeout(() => terminateTree('SIGKILL'), 250);
      force.unref();
    }, timeoutMs);
    timeout.unref();

    return await new Promise<CommandResult>((resolve, reject) => {
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(new ExecutorError('COMMAND_UNAVAILABLE', 'İzinli host komutu başlatılamadı', {
          errorCode: 'code' in error && typeof error.code === 'string' ? error.code : 'SPAWN_FAILED',
        }));
      });
      child.once('close', (exitCode, signal) => {
        clearTimeout(timeout);
        resolve(Object.freeze({
          command: input.command,
          args: Object.freeze([...input.args]),
          exitCode,
          signal,
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          timedOut,
          truncated,
          durationMs: Math.max(0, this.#clock.monotonicMs() - started),
        }));
      });
    });
  }
}
