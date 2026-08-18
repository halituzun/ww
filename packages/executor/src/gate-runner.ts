import { createHash } from 'node:crypto';
import type { EntityId } from '@ww/shared';
import { ExecutorError } from './errors.js';
import type { GateCommitAuditPort } from './ports.js';
import {
  SandboxError,
  type SandboxInputFile,
  type SandboxPort,
  type SandboxStepResult,
} from './sandbox.js';
import { WorkspacePaths, normalizeWorkspaceRelativePath } from './workspace-paths.js';

export interface GateStepV1 {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly timeoutSec?: number;
}

export interface GateConfigV1 {
  readonly version: 1;
  /** Exact source/manifests visible in the sandbox; ww.gate.json is added automatically. */
  readonly inputs: readonly string[];
  /** Bounded generated roots discarded with the sandbox (for example node_modules/dist). */
  readonly discardedOutputs: readonly string[];
  readonly steps: readonly GateStepV1[];
}

export interface GateStepEvidence {
  readonly name: string;
  readonly index: number;
  readonly passed: boolean;
  readonly command: string;
  readonly argumentCount: number;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutHash: string;
  readonly stderrHash: string;
  readonly durationMs: number;
}

export interface GateEvidence {
  readonly passed: boolean;
  readonly configPath: 'ww.gate.json';
  readonly steps: readonly GateStepEvidence[];
}

export interface GateRunContext {
  /**
   * Göreve özgü ek girdi dosyaları (brief.targetFiles). Statik ww.gate.json
   * gelecekteki dosyaları bilemez; dizin listelemek ise geçersizdir çünkü her
   * girdi DOSYA olarak okunur. Bu alan olmadan kapı ya boş kaynakla "geçti"
   * yalanı söyler ya da EISDIR ile düşer.
   */
  readonly extraInputs?: readonly string[];
  readonly operationId: EntityId;
  readonly occurredAt: string;
  readonly deadlineAt?: string;
}

export interface GateInputPolicyPort {
  /** Must compare this exact set to a server-owned sealed manifest. */
  assertAllowed(input: Readonly<{
    projectKey: string;
    configHash: string;
    inputs: readonly string[];
    discardedOutputs: readonly string[];
  }>): Promise<void>;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function pathList(value: unknown, label: string, maximum: number): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum || !value.every((item) => typeof item === 'string')) {
    throw new ExecutorError('GATE_CONFIG_INVALID', `${label} geçersiz`);
  }
  const normalized = value.map(normalizeWorkspaceRelativePath);
  if (new Set(normalized).size !== normalized.length || normalized.some((item, index) => item !== value[index])) {
    throw new ExecutorError('GATE_CONFIG_INVALID', `${label} canonical ve tekil olmalıdır`);
  }
  return Object.freeze(normalized);
}

export function parseGateConfig(value: unknown): GateConfigV1 {
  if (!isRecord(value) || !exactKeys(value, ['version', 'inputs', 'discardedOutputs', 'steps']) || value['version'] !== 1) {
    throw new ExecutorError('GATE_CONFIG_INVALID', 'ww.gate.json version 1 kapalı nesne olmalıdır');
  }
  const inputs = pathList(value['inputs'], 'Gate inputs', 1_024);
  const discardedOutputs = pathList(value['discardedOutputs'], 'Gate discardedOutputs', 32);
  const rawSteps = value['steps'];
  if (!Array.isArray(rawSteps) || rawSteps.length === 0 || rawSteps.length > 32) {
    throw new ExecutorError('GATE_CONFIG_INVALID', 'ww.gate.json 1-32 adım içermelidir');
  }
  const names = new Set<string>();
  const steps = rawSteps.map((raw, index): GateStepV1 => {
    if (!isRecord(raw) || !exactKeys(raw, ['name', 'command', 'args', 'timeoutSec'])) {
      throw new ExecutorError('GATE_CONFIG_INVALID', `Gate adımı ${index} kapalı nesne değil`);
    }
    const name = raw['name'];
    const command = raw['command'];
    const args = raw['args'];
    const timeoutSec = raw['timeoutSec'];
    if (command === 'git') {
      throw new ExecutorError('COMMAND_NOT_ALLOWED', 'Git gate adımı olarak çalıştırılamaz');
    }
    if (
      typeof name !== 'string' || name.trim().length === 0 || name.length > 128 || names.has(name) ||
      typeof command !== 'string' || !/^[A-Za-z0-9._+-]{1,128}$/.test(command) ||
      !Array.isArray(args) || args.length > 256 ||
      !args.every((arg) => typeof arg === 'string' && arg.length <= 32_768 && !arg.includes('\0')) ||
      (timeoutSec !== undefined && (!Number.isSafeInteger(timeoutSec) || Number(timeoutSec) <= 0 || Number(timeoutSec) > 300))
    ) {
      throw new ExecutorError('GATE_CONFIG_INVALID', `Gate adımı ${index} geçersiz`);
    }
    names.add(name);
    return Object.freeze({
      name,
      command,
      args: Object.freeze([...args]),
      ...(timeoutSec === undefined ? {} : { timeoutSec: Number(timeoutSec) }),
    });
  });
  return Object.freeze({ version: 1, inputs, discardedOutputs, steps: Object.freeze(steps) });
}

function evidence(step: SandboxStepResult, index: number): GateStepEvidence {
  return Object.freeze({
    name: step.name,
    index,
    passed: step.exitCode === 0 && !step.timedOut,
    command: step.command,
    argumentCount: step.args.length,
    exitCode: step.exitCode,
    timedOut: step.timedOut,
    truncated: step.truncated,
    stdoutBytes: Buffer.byteLength(step.stdout),
    stderrBytes: Buffer.byteLength(step.stderr),
    stdoutHash: sha256(step.stdout),
    stderrHash: sha256(step.stderr),
    durationMs: step.durationMs,
  });
}

export class GateRunner {
  constructor(
    readonly sandbox: SandboxPort,
    readonly audit: GateCommitAuditPort,
    readonly inputPolicy: GateInputPolicyPort,
  ) {}

  async load(workspace: WorkspacePaths): Promise<{ config: GateConfigV1; raw: string }> {
    const raw = await workspace.readText('ww.gate.json', 0, 262_144);
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch {
      throw new ExecutorError('GATE_CONFIG_INVALID', 'ww.gate.json geçerli JSON değil');
    }
    return { config: parseGateConfig(parsed), raw };
  }

  async run(projectKey: string, workspace: WorkspacePaths, context: GateRunContext): Promise<GateEvidence> {
    const { config, raw } = await this.load(workspace);
    await this.inputPolicy.assertAllowed({
      projectKey,
      configHash: sha256(raw),
      inputs: config.inputs,
      discardedOutputs: config.discardedOutputs,
    });
    const inputFiles: SandboxInputFile[] = [{ path: 'ww.gate.json', content: raw, sha256: sha256(raw) }];
    const seen = new Set<string>(['ww.gate.json']);
    for (const relativePath of [...config.inputs, ...(context.extraInputs ?? [])]) {
      if (seen.has(relativePath)) continue;
      seen.add(relativePath);
      const content = await workspace.readText(relativePath, 0, 1_048_576);
      inputFiles.push({ path: relativePath, content, sha256: sha256(content) });
    }
    let steps: readonly SandboxStepResult[];
    try {
      steps = (await this.sandbox.runPipeline({
        callId: context.operationId,
        projectId: projectKey,
        inputFiles: Object.freeze(inputFiles),
        declaredTargets: [],
        discardedOutputs: config.discardedOutputs,
        steps: config.steps.map((step) => ({
          name: step.name,
          command: step.command,
          args: step.args,
          timeoutMs: (step.timeoutSec ?? 300) * 1_000,
        })),
        ...(context.deadlineAt === undefined ? {} : { deadlineAt: context.deadlineAt }),
      })).steps;
    } catch (error) {
      const code = error instanceof SandboxError ? error.code : 'SANDBOX_UNAVAILABLE';
      await this.audit.appendGate({
        projectKey,
        operationId: context.operationId,
        occurredAt: context.occurredAt,
        step: {
          name: 'sandbox', index: -1, passed: false, exitCode: null,
          timedOut: code === 'SANDBOX_TIMEOUT', truncated: false, durationMs: 0,
          stdoutBytes: 0, stderrBytes: 0, stdoutHash: sha256(''), stderrHash: sha256(''),
        },
      });
      throw error;
    }
    const items: GateStepEvidence[] = [];
    for (const [index, step] of steps.entries()) {
      const item = evidence(step, index);
      items.push(item);
      await this.audit.appendGate({
        projectKey,
        operationId: context.operationId,
        occurredAt: context.occurredAt,
        step: {
          name: item.name,
          index,
          passed: item.passed,
          exitCode: item.exitCode,
          timedOut: item.timedOut,
          truncated: item.truncated,
          durationMs: item.durationMs,
          stdoutBytes: item.stdoutBytes,
          stderrBytes: item.stderrBytes,
          stdoutHash: item.stdoutHash,
          stderrHash: item.stderrHash,
        },
      });
    }
    return Object.freeze({
      passed: items.length === config.steps.length && items.every((item) => item.passed),
      configPath: 'ww.gate.json',
      steps: Object.freeze(items),
    });
  }
}

