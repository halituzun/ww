import {
  EntityIdSchema,
  StructuredVerdictV1Schema,
  canonicalSha256V1,
  type EntityId,
  type JsonValue,
  type PolicyDecision,
} from '@ww/shared';
import { createHash } from 'node:crypto';
import { authorizeTool, EXECUTOR_TOOL_CAPABILITIES } from './capability-policy.js';
import { ExecutorError } from './errors.js';
import type { GitWorkspace } from './git-workspace.js';
import {
  SandboxError,
  type SandboxBaseHash,
  type SandboxCommandResult,
  type SandboxInputFile,
  type SandboxMutation,
  type SandboxPort,
} from './sandbox.js';
import {
  executorToolRegistry,
  type ExecutorToolDefinition,
  type ToolName,
  type ToolRegistry,
} from './tool-registry.js';
import type {
  ExecutorAccessInput,
  ExecutorAccessPort,
  ExecutorAuditPort,
  ExecutorCommunicationPort,
  ExecutorContext,
  ExecutorEffectPort,
  ExecutorIntentPort,
  ExecutorSandboxInputPolicyPort,
  ExecutorToolIntent,
} from './ports.js';
import { WorkspacePaths, normalizeWorkspaceRelativePath } from './workspace-paths.js';

const SANDBOX_AGENT_COMMANDS = new Set([
  'node', 'npm', 'pnpm', 'npx', 'yarn', 'vite', 'tsc', 'eslint', 'prettier',
  'vitest', 'jest', 'flutter', 'dart', 'adb', 'gradle', 'python3', 'pip',
]);

export interface ExecutorToolCall {
  readonly callId: EntityId;
  /** Persisted by the caller with the model tool call; makes audit replay deterministic. */
  readonly occurredAt: string;
  readonly name: string;
  readonly args: unknown;
}

export interface ExecutorToolResult {
  readonly callId: EntityId;
  readonly toolName: ToolName;
  readonly decision: PolicyDecision;
  readonly value: JsonValue;
}

function deterministicEntityId(namespace: string, value: unknown): EntityId {
  const hex = canonicalSha256V1({ namespace, value });
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return EntityIdSchema.parse(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`,
  );
}

function canonicalOccurredAt(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new ExecutorError('INVALID_ARGUMENTS', 'Tool call occurredAt canonical ISO-8601 olmalıdır');
  }
  return value;
}

function text(args: Readonly<Record<string, unknown>>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string') throw new ExecutorError('INVALID_ARGUMENTS', `${key} metin olmalıdır`);
  return value;
}

/** İsteğe bağlı metin argümanı; yoksa undefined döner. */
function optionalText(args: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function optionalInteger(args: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value)) throw new ExecutorError('INVALID_ARGUMENTS', `${key} tam sayı olmalıdır`);
  return Number(value);
}

function textArray(args: Readonly<Record<string, unknown>>, key: string): readonly string[] {
  const value = args[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new ExecutorError('INVALID_ARGUMENTS', `${key} metin dizisi olmalıdır`);
  }
  return Object.freeze([...value]);
}

function accessInput(
  context: ExecutorContext,
  requireFileLock: boolean,
  relativePath?: string,
): ExecutorAccessInput {
  return Object.freeze({
    projectId: context.brief.projectId,
    taskId: context.brief.taskId,
    taskBriefId: context.brief.taskBriefId,
    assignmentAttemptId: context.attempt.assignmentAttemptId,
    agentId: context.agentId,
    taskStatus: context.taskStatus,
    leaseOwner: context.attempt.leaseOwner,
    leaseFence: context.attempt.leaseFence,
    requireFileLock,
    ...(relativePath === undefined ? {} : { relativePath }),
  });
}

function safeCallPayload(args: unknown): JsonValue {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return { argumentType: typeof args };
  return { keys: Object.keys(args).sort(), argumentCount: Object.keys(args).length };
}

function errorCode(error: unknown): string {
  return error instanceof ExecutorError || error instanceof SandboxError ? error.code : 'EXECUTOR_INTERNAL';
}

function contentHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

interface CommandEffectOutcome extends SandboxCommandResult {
  readonly replayed: boolean;
}

export class ToolExecutor {
  readonly #registry: ToolRegistry;
  readonly #access: ExecutorAccessPort;
  readonly #communication: ExecutorCommunicationPort;
  readonly #audit: ExecutorAuditPort;
  readonly #effects: ExecutorEffectPort;
  readonly #intents: ExecutorIntentPort;
  readonly #sandboxInputs: ExecutorSandboxInputPolicyPort;
  readonly #sandbox: SandboxPort;
  readonly #git: Pick<GitWorkspace, 'diff'>;
  readonly #fenceHeartbeatMs: number;

  constructor(input: Readonly<{
    registry?: ToolRegistry;
    access: ExecutorAccessPort;
    communication: ExecutorCommunicationPort;
    audit: ExecutorAuditPort;
    effects: ExecutorEffectPort;
    intents: ExecutorIntentPort;
    sandboxInputs: ExecutorSandboxInputPolicyPort;
    sandbox: SandboxPort;
    gitWorkspace: Pick<GitWorkspace, 'diff'>;
    fenceHeartbeatMs?: number;
  }>) {
    this.#registry = input.registry ?? executorToolRegistry;
    this.#access = input.access;
    this.#communication = input.communication;
    this.#audit = input.audit;
    this.#effects = input.effects;
    this.#intents = input.intents;
    this.#sandboxInputs = input.sandboxInputs;
    this.#sandbox = input.sandbox;
    this.#git = input.gitWorkspace;
    this.#fenceHeartbeatMs = input.fenceHeartbeatMs ?? 1_000;
    if (!Number.isSafeInteger(this.#fenceHeartbeatMs) || this.#fenceHeartbeatMs <= 0) {
      throw new ExecutorError('INVALID_ARGUMENTS', 'fenceHeartbeatMs pozitif tam sayı olmalıdır');
    }
  }

  definitions(context: ExecutorContext): readonly ExecutorToolDefinition[] {
    const names = [...new Set(context.brief.allowedTools)]
      .filter((name): name is ToolName => this.#registry.has(name))
      .filter((name) => EXECUTOR_TOOL_CAPABILITIES[name].allowedRoles.includes(context.agentRole) &&
        EXECUTOR_TOOL_CAPABILITIES[name].allowedTaskStatuses.includes(context.taskStatus));
    return this.#registry.definitions(names);
  }

  async execute(context: ExecutorContext, call: ExecutorToolCall): Promise<ExecutorToolResult> {
    const callId = EntityIdSchema.parse(call.callId);
    const occurredAt = canonicalOccurredAt(call.occurredAt);
    await this.#appendAudit(context, callId, call.name, occurredAt, 'tool_call', safeCallPayload(call.args));
    let executionCompleted = false;
    let attemptedRequestHash: string | undefined;
    try {
      if (!this.#registry.has(call.name)) {
        throw new ExecutorError('INVALID_TOOL', `Bilinmeyen tool: ${call.name}`);
      }
      const name = call.name;
      const args = this.#registry.parseArguments(name, call.args);
      const rawPath = typeof args['path'] === 'string' ? args['path'] : undefined;
      const normalizedPath = rawPath === undefined ? undefined : normalizeWorkspaceRelativePath(rawPath);
      const decision = authorizeTool(context, name, normalizedPath);
      const argsHash = canonicalSha256V1(args);
      const requestHash = canonicalSha256V1({
        contractVersion: 1,
        callId,
        name,
        argsHash,
        projectId: context.brief.projectId,
        taskId: context.brief.taskId,
        taskBriefId: context.brief.taskBriefId,
        assignmentAttemptId: context.attempt.assignmentAttemptId,
        agentId: context.agentId,
        leaseOwner: context.attempt.leaseOwner,
        leaseFence: context.attempt.leaseFence,
      });
      attemptedRequestHash = requestHash;
      const intent: ExecutorToolIntent = Object.freeze({
        callId,
        toolName: name,
        projectId: context.brief.projectId,
        taskId: context.brief.taskId,
        taskBriefId: context.brief.taskBriefId,
        assignmentAttemptId: context.attempt.assignmentAttemptId,
        agentId: context.agentId,
        leaseOwner: context.attempt.leaseOwner,
        leaseFence: context.attempt.leaseFence,
        argsHash,
        requestHash,
        occurredAt,
      });
      const acceptance = await this.#intents.accept(intent);
      const capability = EXECUTOR_TOOL_CAPABILITIES[name];
      const access = accessInput(context, capability.requiresFileLock, normalizedPath);
      await this.#access.assertAuthorized(access);
      const workspace = await new WorkspacePaths(context.workspaceRoot).initialize();
      const value = await this.#executeAuthorized(
        context,
        callId,
        occurredAt,
        workspace,
        name,
        args,
        access,
        acceptance.state === 'replay' || acceptance.state === 'completed',
      );
      executionCompleted = true;
      const resultHash = canonicalSha256V1(this.#safeResult(name, value));
      if (acceptance.state === 'completed' && acceptance.resultHash !== resultHash) {
        throw new ExecutorError('CALL_INTENT_CONFLICT', 'Tamamlanmış tool çağrısı farklı sonuç üretti');
      }
      await this.#intents.complete({ intent, resultHash });
      await this.#appendAudit(context, callId, name, occurredAt, 'tool_result', {
        ok: true,
        result: this.#safeResult(name, value),
      });
      return Object.freeze({ callId, toolName: name, decision, value });
    } catch (error) {
      // Once the tool body returned, a completion/audit response can be lost after a
      // mutation. Do not persist a contradictory failure under the immutable result id;
      // the exact-intent ledger drives recovery on the next call.
      if (!executionCompleted) {
        await this.#appendAudit(context, callId, call.name, occurredAt, 'error', {
          ok: false,
          errorCode: errorCode(error),
          ...(attemptedRequestHash === undefined ? {} : { requestHash: attemptedRequestHash }),
        });
      }
      throw error;
    }
  }

  async #executeAuthorized(
    context: ExecutorContext,
    callId: EntityId,
    occurredAt: string,
    workspace: WorkspacePaths,
    name: ToolName,
    args: Readonly<Record<string, unknown>>,
    access: ExecutorAccessInput,
    replay: boolean,
  ): Promise<JsonValue> {
    switch (name) {
      case 'read_file': {
        const relativePath = workspace.assertDeclared(text(args, 'path'), context.brief.targetFiles);
        const offset = optionalInteger(args, 'offset') ?? 0;
        const limit = optionalInteger(args, 'limit') ?? 1_048_576;
        const content = await workspace.readText(relativePath, offset, limit);
        return { path: relativePath, offset, content, bytes: Buffer.byteLength(content) };
      }
      case 'list_dir': {
        // docs/05'te tanımlı ama hiç yazılmamıştı. Worker hangi dosyaların var
        // olduğunu göremediği için canlı koşuda "Workspace'te hangi dosyalar
        // mevcut?" diye sorup durdu ve bir tur boşa gitti.
        //
        // OKUMA aracıdır: mühürlü hedef listesi YAZMAYI sınırlar, görmeyi
        // değil. Kapsam çalışma alanıdır ve dışına çıkılamaz.
        const requested = optionalText(args, 'path') ?? '';
        const files = await workspace.listFiles(requested);
        return { path: requested === '' ? '.' : requested, files, count: files.length };
      }
      case 'search_code': {
        // Worker yalnızca adını bildiği dosyayı okuyabiliyordu; "bu fonksiyon
        // nerede tanımlı" sorusunun cevabı yoktu ve her arama kullanıcıya
        // sorulan bir soruya dönüşüyordu.
        const pattern = text(args, 'pattern');
        const matches = await workspace.searchText(pattern);
        return { pattern, matches, count: matches.length };
      }
      case 'write_file': {
        const relativePath = workspace.assertDeclared(text(args, 'path'), context.brief.targetFiles);
        const content = text(args, 'content');
        await workspace.atomicWrite(relativePath, content, () => this.#access.assertAuthorized(access));
        return { path: relativePath, bytes: Buffer.byteLength(content), written: true };
      }
      case 'edit_file': {
        const relativePath = workspace.assertDeclared(text(args, 'path'), context.brief.targetFiles);
        const oldText = text(args, 'old');
        const newText = text(args, 'new');
        if (oldText === newText) {
          throw new ExecutorError('INVALID_ARGUMENTS', 'edit_file old ve new metinleri farklı olmalıdır');
        }
        try {
          await workspace.editText(
            relativePath, oldText, newText,
            () => this.#access.assertAuthorized(access),
          );
          return { path: relativePath, edited: true, recovered: false };
        } catch (error) {
          if (!replay || !(error instanceof ExecutorError) || error.code !== 'EDIT_MISMATCH') throw error;
          const current = await workspace.readText(relativePath, 0, 1_048_576);
          if (current.includes(oldText) || !current.includes(newText)) throw error;
          await this.#access.assertAuthorized(access);
          return { path: relativePath, edited: true, recovered: true };
        }
      }
      case 'run_command':
        return await this.#runSandboxCommand(context, callId, occurredAt, workspace, args, access);
      case 'git_diff': {
        const result = await this.#git.diff(context.brief.projectId, workspace, context.brief.targetFiles);
        return { diff: result.diff, truncated: result.truncated };
      }
      case 'ask_question':
        return await this.#communication.askQuestion({
          ...this.#communicationContext(context, callId, name), to: 'pm', content: text(args, 'content'),
        });
      case 'report_result':
        return await this.#communication.reportResult({
          ...this.#communicationContext(context, callId, name),
          summary: text(args, 'summary'), evidenceRefs: textArray(args, 'evidenceRefs'),
        });
      case 'submit_verdict':
        return await this.#communication.submitVerdict({
          ...this.#communicationContext(context, callId, name), verdict: StructuredVerdictV1Schema.parse(args),
        });
    }
  }

  async #runSandboxCommand(
    context: ExecutorContext,
    callId: EntityId,
    occurredAt: string,
    workspace: WorkspacePaths,
    args: Readonly<Record<string, unknown>>,
    access: ExecutorAccessInput,
  ): Promise<JsonValue> {
    const command = text(args, 'cmd');
    if (!SANDBOX_AGENT_COMMANDS.has(command)) {
      throw new ExecutorError('COMMAND_NOT_ALLOWED', `Agent komutu izin listesinde değil: ${command}`);
    }
    const commandArgs = textArray(args, 'args');
    const timeoutMs = (optionalInteger(args, 'timeoutSec') ?? 300) * 1_000;
    const stableEffectId = `executor.run_command.v1:${callId}`;
    const inputFiles = await this.#sandboxInputFiles(context, workspace);
    const expectedBases: SandboxBaseHash[] = [
      ...inputFiles.map((file) => ({ path: file.path, sha256: file.sha256 })),
      ...context.brief.targetFiles
        .map(normalizeWorkspaceRelativePath)
        .filter((target) => !inputFiles.some((file) => file.path === target))
        .map((target) => ({ path: target, sha256: '<missing>' })),
    ].sort((left, right) => left.path.localeCompare(right.path));
    const commandArgsHash = canonicalSha256V1(commandArgs);
    const request = {
      contractVersion: 1,
      projectId: context.brief.projectId,
      taskId: context.brief.taskId,
      assignmentAttemptId: context.attempt.assignmentAttemptId,
      callId,
      command,
      commandArgsHash,
      timeoutMs,
      declaredTargets: context.brief.targetFiles,
      baseHashes: expectedBases.map((base) => ({ path: base.path, sha256: base.sha256 })),
    } as const;
    const result = await this.#effects.run<CommandEffectOutcome>({
      projectId: context.brief.projectId,
      taskId: context.brief.taskId,
      assignmentAttemptId: context.attempt.assignmentAttemptId,
      causationId: callId,
      stableEffectId,
      effectType: 'executor.run_command.v1',
      replaySafety: 'non_replay_safe',
      request,
      escalationContext: {
        sessionId: context.effectEscalation.sessionId,
        owningPmId: context.effectEscalation.owningPmId,
        taskBriefId: context.brief.taskBriefId,
      },
      createdAt: occurredAt,
      execute: async () => {
        const controller = new AbortController();
        let fenceFailure: unknown;
        let checking = false;
        const checkFence = async (): Promise<void> => {
          if (checking || fenceFailure !== undefined) return;
          checking = true;
          try {
            await this.#access.assertAuthorized(access);
          } catch (error) {
            fenceFailure = error;
            controller.abort();
          } finally {
            checking = false;
          }
        };
        await checkFence();
        if (fenceFailure !== undefined) throw new ExecutorError('FENCE_LOST', 'Komut başlamadan task fence kaybedildi');
        const monitor = setInterval(() => { void checkFence(); }, this.#fenceHeartbeatMs);
        monitor.unref();
        try {
          const output = await this.#sandbox.run({
            callId,
            projectId: context.brief.projectId,
            inputFiles,
            declaredTargets: context.brief.targetFiles,
            command,
            args: commandArgs,
            timeoutMs,
            ...(context.brief.deadlineAt === undefined ? {} : { deadlineAt: context.brief.deadlineAt }),
            signal: controller.signal,
          });
          if (fenceFailure !== undefined) throw new ExecutorError('FENCE_LOST', 'Çalışan komut task fence kaybetti');
          this.#assertBaseHashes(expectedBases, output.baseHashes);
          await this.#publishSandboxMutations(context, workspace, output.baseHashes, output.mutations);
          return Object.freeze({ ...output, replayed: false });
        } catch (error) {
          if (fenceFailure !== undefined) {
            throw new ExecutorError('FENCE_LOST', 'Çalışan komut task fence kaybetti', { causeCode: errorCode(fenceFailure) });
          }
          throw error;
        } finally {
          clearInterval(monitor);
        }
      },
      serialize: (value) => this.#sandboxResultJson(value),
      parse: (value) => this.#parseSandboxResult(value),
    });
    await this.#access.assertAuthorized(access);
    return {
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
      truncated: result.truncated,
      durationMs: result.durationMs,
      replayed: result.replayed,
    };
  }

  async #sandboxInputFiles(
    context: ExecutorContext,
    workspace: WorkspacePaths,
  ): Promise<readonly SandboxInputFile[]> {
    const trusted = await this.#sandboxInputs.resolveTrustedInputs({
      projectId: context.brief.projectId,
      taskId: context.brief.taskId,
      taskBriefId: context.brief.taskBriefId,
      assignmentAttemptId: context.attempt.assignmentAttemptId,
      agentId: context.agentId,
      toolName: 'run_command',
    });
    const targets = context.brief.targetFiles.map(normalizeWorkspaceRelativePath);
    const trustedNormalized = trusted.map(normalizeWorkspaceRelativePath);
    if (new Set(trustedNormalized).size !== trustedNormalized.length ||
      trustedNormalized.some((item, index) => item !== trusted[index])) {
      throw new ExecutorError('INVALID_ARGUMENTS', 'Sandbox trusted input manifest canonical ve tekil olmalıdır');
    }
    const files: SandboxInputFile[] = [];
    for (const relativePath of [...new Set([...targets, ...trustedNormalized])].sort()) {
      try {
        const content = await workspace.readText(relativePath, 0, 1_048_576);
        files.push(Object.freeze({ path: relativePath, content, sha256: contentHash(content) }));
      } catch (error) {
        if (error instanceof ExecutorError && error.code === 'FILE_NOT_FOUND' && targets.includes(relativePath)) continue;
        throw error;
      }
    }
    return Object.freeze(files);
  }

  #assertBaseHashes(expected: readonly SandboxBaseHash[], actual: readonly SandboxBaseHash[]): void {
    const canonical = (items: readonly SandboxBaseHash[]) => [...items]
      .map((item) => ({ path: normalizeWorkspaceRelativePath(item.path), sha256: item.sha256 }))
      .sort((left, right) => left.path.localeCompare(right.path));
    if (canonicalSha256V1(canonical(expected)) !== canonicalSha256V1(canonical(actual))) {
      throw new ExecutorError('SANDBOX_RESULT_INVALID', 'Sandbox base snapshot isteğiyle uyuşmuyor');
    }
  }

  async #publishSandboxMutations(
    context: ExecutorContext,
    workspace: WorkspacePaths,
    bases: readonly SandboxBaseHash[],
    mutations: readonly SandboxMutation[],
  ): Promise<void> {
    const baseByPath = new Map(bases.map((base) => [base.path, base.sha256]));
    const prepared: Array<{
      readonly mutation: SandboxMutation;
      readonly relativePath: string;
      readonly baseHash: string;
      readonly targetAccess: ExecutorAccessInput;
    }> = [];
    for (const mutation of mutations) {
      const relativePath = workspace.assertDeclared(mutation.path, context.brief.targetFiles);
      if (contentHash(mutation.content) !== mutation.sha256) {
        throw new ExecutorError('SANDBOX_RESULT_INVALID', 'Sandbox mutation hash doğrulaması başarısız');
      }
      const baseHash = baseByPath.get(relativePath);
      if (baseHash === undefined) throw new ExecutorError('SANDBOX_RESULT_INVALID', 'Mutation base hash içermiyor');
      const targetAccess = accessInput(context, true, relativePath);
      await this.#access.assertAuthorized(targetAccess);
      const currentHash = await this.#currentContentHash(workspace, relativePath);
      if (currentHash === mutation.sha256) continue;
      if (currentHash !== baseHash) {
        throw new ExecutorError('FILE_CONFLICT', 'Sandbox sonrası hedef dosya eşzamanlı değişti');
      }
      prepared.push({ mutation, relativePath, baseHash, targetAccess });
    }
    // Validate every target before the first publish so a conflict cannot leave a
    // deterministic multi-file result partially applied.
    for (const item of prepared) {
      await this.#access.assertAuthorized(item.targetAccess);
      const currentHash = await this.#currentContentHash(workspace, item.relativePath);
      if (currentHash !== item.baseHash && currentHash !== item.mutation.sha256) {
        throw new ExecutorError('FILE_CONFLICT', 'Sandbox mutation preflight CAS fence kaybetti');
      }
    }
    for (const { mutation, relativePath, baseHash, targetAccess } of prepared) {
      if (await this.#currentContentHash(workspace, relativePath) === mutation.sha256) continue;
      await workspace.atomicWrite(relativePath, mutation.content, async () => {
        await this.#access.assertAuthorized(targetAccess);
        if (await this.#currentContentHash(workspace, relativePath) !== baseHash) {
          throw new ExecutorError('FILE_CONFLICT', 'Sandbox mutation CAS fence kaybetti');
        }
      });
    }
  }

  async #currentContentHash(workspace: WorkspacePaths, relativePath: string): Promise<string> {
    try {
      return contentHash(await workspace.readText(relativePath, 0, 1_048_576));
    } catch (error) {
      if (error instanceof ExecutorError && error.code === 'FILE_NOT_FOUND') return '<missing>';
      throw error;
    }
  }

  #communicationContext(context: ExecutorContext, callId: EntityId, name: ToolName) {
    return Object.freeze({
      callId,
      idempotencyKey: `executor.${name}.v1:${callId}`,
      projectId: context.brief.projectId,
      taskId: context.brief.taskId,
      taskBriefId: context.brief.taskBriefId,
      assignmentAttemptId: context.attempt.assignmentAttemptId,
      agentId: context.agentId,
    });
  }

  #sandboxResultJson(value: CommandEffectOutcome): JsonValue {
    return {
      command: value.command,
      argumentCount: value.args.length,
      exitCode: value.exitCode,
      signal: value.signal,
      stdoutBytes: Buffer.byteLength(value.stdout),
      stderrBytes: Buffer.byteLength(value.stderr),
      stdoutHash: contentHash(value.stdout),
      stderrHash: contentHash(value.stderr),
      timedOut: value.timedOut,
      truncated: value.truncated,
      durationMs: value.durationMs,
      baseHashes: value.baseHashes.map((base) => ({ path: base.path, sha256: base.sha256 })),
      mutations: value.mutations.map((mutation) => ({ path: mutation.path, sha256: mutation.sha256 })),
    };
  }

  #parseSandboxResult(value: JsonValue): CommandEffectOutcome {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new ExecutorError('EFFECT_OUTCOME_UNKNOWN', 'Kalıcı sandbox sonucu nesne değil');
    }
    const record = value as Readonly<Record<string, JsonValue>>;
    const command = record['command'];
    const argumentCount = record['argumentCount'];
    const mutations = record['mutations'];
    const baseHashes = record['baseHashes'];
    if (
      typeof command !== 'string' || typeof argumentCount !== 'number' ||
      !Array.isArray(mutations) || !mutations.every((item) => item !== null && typeof item === 'object' &&
        !Array.isArray(item) && typeof item['path'] === 'string' && typeof item['sha256'] === 'string') ||
      !Array.isArray(baseHashes) || !baseHashes.every((item) => item !== null && typeof item === 'object' &&
        !Array.isArray(item) && typeof item['path'] === 'string' && typeof item['sha256'] === 'string') ||
      !(typeof record['exitCode'] === 'number' || record['exitCode'] === null) ||
      !(typeof record['signal'] === 'string' || record['signal'] === null) ||
      typeof record['timedOut'] !== 'boolean' || typeof record['truncated'] !== 'boolean' ||
      typeof record['durationMs'] !== 'number' || !Number.isSafeInteger(argumentCount) ||
      argumentCount < 0 || argumentCount > 256
    ) {
      throw new ExecutorError('EFFECT_OUTCOME_UNKNOWN', 'Kalıcı sandbox sonucu sözleşmeyle uyuşmuyor');
    }
    return Object.freeze({
      command,
      name: 'command',
      args: Object.freeze(Array.from({ length: argumentCount }, () => '<redacted>')),
      exitCode: record['exitCode'],
      signal: record['signal'] as NodeJS.Signals | null,
      stdout: '',
      stderr: '',
      timedOut: record['timedOut'],
      truncated: record['truncated'],
      durationMs: record['durationMs'],
      baseHashes: Object.freeze(baseHashes.map((item) => Object.freeze({
        path: (item as Readonly<Record<string, JsonValue>>)['path'] as string,
        sha256: (item as Readonly<Record<string, JsonValue>>)['sha256'] as string,
      }))),
      mutations: Object.freeze([]),
      replayed: true,
    });
  }

  #safeResult(name: ToolName, value: JsonValue): JsonValue {
    const object = value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Readonly<Record<string, JsonValue>>
      : {};
    if (name === 'read_file') return { path: object['path'] ?? '', bytes: object['bytes'] ?? 0 };
    if (name === 'write_file' || name === 'edit_file') {
      return { path: object['path'] ?? '', changed: true };
    }
    if (name === 'run_command') {
      return {
        exitCode: object['exitCode'] ?? null,
        timedOut: object['timedOut'] ?? false,
        truncated: object['truncated'] ?? false,
        durationMs: object['durationMs'] ?? 0,
      };
    }
    if (name === 'git_diff') return { truncated: object['truncated'] ?? false };
    return { accepted: true, resultKeys: Object.keys(object).sort() };
  }

  async #appendAudit(
    context: ExecutorContext,
    callId: EntityId,
    name: string,
    occurredAt: string,
    eventType: 'tool_call' | 'tool_result' | 'error',
    payload: JsonValue,
  ): Promise<void> {
    try {
      const knownName = this.#registry.has(name) ? name : '<invalid>';
      await this.#audit.append(Object.freeze({
        eventId: deterministicEntityId(`executor.${eventType}`, {
          callId,
          nameHash: canonicalSha256V1({ name }),
          payloadHash: canonicalSha256V1(payload),
        }),
        projectId: context.brief.projectId,
        taskId: context.brief.taskId,
        assignmentAttemptId: context.attempt.assignmentAttemptId,
        agentId: context.agentId,
        eventType,
        toolCallId: callId,
        toolName: knownName,
        occurredAt,
        payload,
      }));
    } catch {
      throw new ExecutorError('AUDIT_FAILED', 'Executor audit olayı kalıcılaştırılamadı');
    }
  }
}
