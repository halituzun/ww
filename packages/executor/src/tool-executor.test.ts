import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  AssignmentAttemptV1Schema,
  EntityIdSchema,
  TaskBriefV1Schema,
  type AgentRole,
  type TaskStatus,
} from '@ww/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExecutorError } from './errors.js';
import type {
  ExecutorAccessPort,
  ExecutorAuditEvent,
  ExecutorAuditPort,
  ExecutorCommunicationPort,
  ExecutorContext,
  ExecutorEffectPort,
  ExecutorIntentPort,
  ExecutorSandboxInputPolicyPort,
  ExecutorToolIntent,
} from './ports.js';
import type { SandboxCommandResult, SandboxPort } from './sandbox.js';
import { ToolExecutor } from './tool-executor.js';

const cleanup: string[] = [];
const hash = (character: string) => character.repeat(64);
const id = () => EntityIdSchema.parse(randomUUID());
const occurredAt = '2026-08-15T10:00:00.000Z';
const contentHash = (value: string) => createHash('sha256').update(value).digest('hex');

function sandboxResult(
  input: Parameters<SandboxPort['run']>[0],
  overrides: Partial<SandboxCommandResult> = {},
): SandboxCommandResult {
  const supplied = new Map(input.inputFiles.map((file) => [file.path, file.sha256]));
  return {
    name: 'command', command: input.command, args: input.args, exitCode: 0, signal: null,
    stdout: '', stderr: '', timedOut: false, truncated: false, durationMs: 1,
    baseHashes: [...new Set([...supplied.keys(), ...input.declaredTargets])].sort().map((relativePath) => ({
      path: relativePath, sha256: supplied.get(relativePath) ?? '<missing>',
    })),
    mutations: [],
    ...overrides,
  };
}

class DurableIntentFake implements ExecutorIntentPort {
  readonly accepted = new Map<string, { serialized: string; intent: ExecutorToolIntent; resultHash?: string }>();
  loseCompleteResponse = false;

  async accept(intent: ExecutorToolIntent) {
    const serialized = JSON.stringify(intent);
    const current = this.accepted.get(intent.callId);
    if (current === undefined) {
      this.accepted.set(intent.callId, { serialized, intent });
      return { state: 'accepted' as const };
    }
    if (current.serialized !== serialized) {
      throw new ExecutorError('CALL_INTENT_CONFLICT', 'divergent exact intent');
    }
    return current.resultHash === undefined
      ? { state: 'replay' as const }
      : { state: 'completed' as const, resultHash: current.resultHash };
  }

  async complete(input: Readonly<{ intent: ExecutorToolIntent; resultHash: string }>): Promise<void> {
    const current = this.accepted.get(input.intent.callId);
    if (current === undefined || current.serialized !== JSON.stringify(input.intent)) throw new Error('missing intent');
    if (current.resultHash !== undefined && current.resultHash !== input.resultHash) {
      throw new ExecutorError('CALL_INTENT_CONFLICT', 'divergent result');
    }
    current.resultHash = input.resultHash;
    if (this.loseCompleteResponse) { this.loseCompleteResponse = false; throw new Error('lost complete response'); }
  }
}

async function context(
  allowedTools: readonly string[],
  agentRole: AgentRole = 'worker',
  taskStatus: TaskStatus = agentRole === 'verifier' ? 'verifying' : 'working',
): Promise<ExecutorContext> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'ww-tool-'));
  cleanup.push(workspaceRoot);
  await writeFile(path.join(workspaceRoot, 'a.ts'), 'old\n');
  const projectId = id();
  const taskId = id();
  const taskBriefId = id();
  const planId = id();
  const promptId = id();
  const contextSnapshotId = id();
  const workerAgentId = id();
  const verifierAgentId = id();
  const brief = TaskBriefV1Schema.parse({
    contractVersion: 1,
    taskBriefId,
    taskBriefVersion: 1,
    projectId,
    taskId,
    taskVersion: 1,
    planId,
    planVersion: 1,
    planHash: hash('a'),
    goal: 'Executor test',
    acceptanceCriteria: ['Güvenli çalışır'],
    dependencyTaskIds: [],
    targetFiles: ['a.ts'],
    allowedTools,
    tokenBudget: 1000,
    deadlineAt: '2099-01-02T00:00:00.000Z',
    promptRefs: [{ sourceType: 'prompt', sourceId: promptId, version: 1, hash: hash('b') }],
    ruleRefs: [{ ruleId: 'TOOL-001', ruleVersion: 1, hash: hash('c') }],
    standardRefs: [],
    contextSnapshotId,
    baseContextCutoffAt: '2099-01-01T00:00:00.000Z',
    sourceVersionManifest: [
      { sourceType: 'plan', sourceId: planId, version: 1, hash: hash('a') },
      { sourceType: 'prompt', sourceId: promptId, version: 1, hash: hash('b') },
      { sourceType: 'rule', sourceId: 'TOOL-001', version: 1, hash: hash('c') },
    ],
    verificationMode: 'required',
    sealedAt: '2099-01-01T00:00:00.000Z',
  });
  const attempt = AssignmentAttemptV1Schema.parse({
    contractVersion: 1,
    assignmentAttemptId: id(),
    projectId,
    taskId,
    taskBriefId,
    attemptNumber: 1,
    workerAgentId,
    verifierAgentId,
    leaseOwner: 'scheduler:test',
    leaseFence: 7,
    leaseExpiresAt: '2099-01-02T00:00:00.000Z',
    startReason: 'initial',
    assignedAt: '2099-01-01T00:00:00.000Z',
  });
  return Object.freeze({
    workspaceRoot,
    agentId: agentRole === 'verifier' ? verifierAgentId : workerAgentId,
    agentRole,
    taskStatus,
    brief,
    attempt,
    effectEscalation: { sessionId: id(), owningPmId: id() },
  });
}

function harness(
  access: ExecutorAccessPort = { assertAuthorized: vi.fn(async () => undefined) },
  sandbox: SandboxPort = {
    run: vi.fn(async (input) => sandboxResult(input)),
    runPipeline: vi.fn(async () => { throw new Error('not used'); }),
  },
  effectOverride?: ExecutorEffectPort,
  intentOverride: ExecutorIntentPort = new DurableIntentFake(),
  sandboxInputs: ExecutorSandboxInputPolicyPort = { resolveTrustedInputs: vi.fn(async () => []) },
) {
  const events: ExecutorAuditEvent[] = [];
  const audit: ExecutorAuditPort = { append: vi.fn(async (event) => { events.push(event); }) };
  const communication: ExecutorCommunicationPort = {
    askQuestion: vi.fn(async () => ({ messageId: 'question' })),
    reportResult: vi.fn(async () => ({ transition: 'verifying' })),
    submitVerdict: vi.fn(async () => ({ transition: 'testing' })),
  };
  const effects: ExecutorEffectPort = effectOverride ?? {
    run: async <T>(input: Parameters<ExecutorEffectPort['run']>[0]) => await input.execute({
      externalIdempotencyKey: input.stableEffectId,
    }) as T,
  };
  const memory = { query: vi.fn(async () => [] as never) };
  return {
    access,
    audit,
    events,
    communication,
    effects,
    intents: intentOverride,
    sandboxInputs,
    sandbox,
    memory,
    executor: new ToolExecutor({
      access,
      audit,
      communication,
      effects,
      memory,
      intents: intentOverride,
      sandboxInputs,
      sandbox,
      gitWorkspace: { diff: vi.fn(async () => ({ diff: '', truncated: false })) },
      fenceHeartbeatMs: 5,
    }),
  };
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('ToolExecutor', () => {
  it('write_file için current fence/locku önce ve rename öncesi tekrar doğrular', async () => {
    const ctx = await context(['write_file']);
    const test = harness();
    const result = await test.executor.execute(ctx, {
      callId: id(), occurredAt, name: 'write_file', args: { path: 'a.ts', content: 'new\n' },
    });
    expect(result.value).toEqual({ path: 'a.ts', bytes: 4, written: true });
    expect(test.access.assertAuthorized).toHaveBeenCalledTimes(2);
    expect(test.access.assertAuthorized).toHaveBeenCalledWith(expect.objectContaining({
      relativePath: 'a.ts', requireFileLock: true, leaseFence: 7,
    }));
    expect(await readFile(path.join(ctx.workspaceRoot, 'a.ts'), 'utf8')).toBe('new\n');
    expect(test.events.map((event) => event.eventType)).toEqual(['tool_call', 'tool_result']);
  });

  it('eksik lock/fence doğrulamasında dosyaya dokunmaz', async () => {
    const ctx = await context(['write_file']);
    const access: ExecutorAccessPort = {
      assertAuthorized: vi.fn(async () => {
        throw new ExecutorError('LOCK_REQUIRED', 'current lock yok');
      }),
    };
    const test = harness(access);
    await expect(test.executor.execute(ctx, {
      callId: id(), occurredAt, name: 'write_file', args: { path: 'a.ts', content: 'bad\n' },
    })).rejects.toMatchObject({ code: 'LOCK_REQUIRED' });
    expect(await readFile(path.join(ctx.workspaceRoot, 'a.ts'), 'utf8')).toBe('old\n');
    expect(test.events.map((event) => event.eventType)).toEqual(['tool_call', 'error']);
    expect(test.events[1]?.payload).toMatchObject({ ok: false, errorCode: 'LOCK_REQUIRED' });
  });

  // Testin niyeti: yetki kontrolü ERİŞİM PORTUNDAN ÖNCE koşar. Eskiden bu
  // `read_file` ile yazılmıştı; artık okuma hedef listesine bağlı değil
  // (görme aracıdır), o yüzden sınır YAZMA aracıyla sınanır.
  it('beyan edilmeyen hedefi access portundan önce reddeder', async () => {
    const ctx = await context(['write_file']);
    const test = harness();
    await expect(test.executor.execute(ctx, {
      callId: id(), occurredAt, name: 'write_file', args: { path: 'other.ts', content: 'x' },
    })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    expect(test.access.assertAuthorized).not.toHaveBeenCalled();
  });

  // Okuma hedef listesiyle SINIRLANMAZ: worker mevcut kodu görebilmeli.
  it('beyan edilmeyen dosyayi OKUYABILIR', async () => {
    const ctx = await context(['read_file']);
    const test = harness();
    await expect(test.executor.execute(ctx, {
      callId: id(), occurredAt, name: 'read_file', args: { path: 'other.ts' },
    })).rejects.not.toMatchObject({ code: 'CAPABILITY_DENIED' });
  });

  it('git komutunu run_command üzerinden dolaştırmayı reddeder', async () => {
    const ctx = await context(['run_command']);
    const test = harness();
    await expect(test.executor.execute(ctx, {
      callId: id(), occurredAt, name: 'run_command', args: { cmd: 'git', args: ['status'] },
    })).rejects.toMatchObject({ code: 'COMMAND_NOT_ALLOWED' });
  });

  it('iletişim araçlarını dar porta taşır ve DB/task durumuna kendisi yazmaz', async () => {
    const worker = await context(['ask_question', 'report_result']);
    const workerHarness = harness();
    const questionCallId = id();
    await workerHarness.executor.execute(worker, {
      callId: questionCallId, occurredAt, name: 'ask_question', args: { to: 'pm', content: 'Karar nedir?' },
    });
    await workerHarness.executor.execute(worker, {
      callId: id(), occurredAt, name: 'report_result', args: { summary: 'Bitti', evidenceRefs: ['diff:1'] },
    });
    expect(workerHarness.communication.askQuestion).toHaveBeenCalledWith(expect.objectContaining({
      taskId: worker.brief.taskId,
      to: 'pm',
      callId: questionCallId,
      idempotencyKey: `executor.ask_question.v1:${questionCallId}`,
    }));
    expect(workerHarness.communication.reportResult).toHaveBeenCalledWith(expect.objectContaining({
      assignmentAttemptId: worker.attempt.assignmentAttemptId,
      evidenceRefs: ['diff:1'],
    }));

    const verifier = await context(['submit_verdict'], 'verifier');
    const verifierHarness = harness();
    await verifierHarness.executor.execute(verifier, {
      callId: id(),
      occurredAt,
      name: 'submit_verdict',
      args: {
        decision: 'approve',
        reasons: [{ message: 'Kanıt yeterli', evidenceRefs: ['diff:1'] }],
        evidenceRefs: ['gate:1'],
        ruleRefs: [{ ruleId: 'TOOL-001', ruleVersion: 1 }],
      },
    });
    expect(verifierHarness.communication.submitVerdict).toHaveBeenCalledWith(expect.objectContaining({
      verdict: expect.objectContaining({ decision: 'approve' }),
    }));
  });

  it('rol, durum ve sealed allowedTools dışındaki çağrıları fail-closed reddeder', async () => {
    const missing = await context(['read_file']);
    const test = harness();
    await expect(test.executor.execute(missing, {
      callId: id(), occurredAt, name: 'write_file', args: { path: 'a.ts', content: 'x' },
    })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });

    const verifier = await context(['write_file'], 'verifier');
    await expect(test.executor.execute(verifier, {
      callId: id(), occurredAt, name: 'write_file', args: { path: 'a.ts', content: 'x' },
    })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });

    const wrongStatus = await context(['report_result'], 'worker', 'assigned');
    await expect(test.executor.execute(wrongStatus, {
      callId: id(), occurredAt, name: 'report_result', args: { summary: 'x', evidenceRefs: [] },
    })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  });

  it('read_file sonucu dışında dosya içeriğini audit olayına koymaz', async () => {
    const ctx = await context(['read_file']);
    const test = harness();
    const result = await test.executor.execute(ctx, {
      callId: id(), occurredAt, name: 'read_file', args: { path: 'a.ts' },
    });
    expect((result.value as { content: string }).content).toBe('old\n');
    expect(JSON.stringify(test.events)).not.toContain('old\\n');
  });

  it('bilinmeyen tool ve geçersiz argümanları da secretsız durable audit eder', async () => {
    const ctx = await context(['write_file']);
    const test = harness();
    const secret = 'sk-live-super-secret-123456789';
    await expect(test.executor.execute(ctx, {
      callId: id(), occurredAt, name: 'unknown_tool', args: { token: secret },
    })).rejects.toMatchObject({ code: 'INVALID_TOOL' });
    await expect(test.executor.execute(ctx, {
      callId: id(), occurredAt, name: 'write_file',
      args: { path: 'a.ts', content: secret, extra: true },
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' });
    expect(test.events.map((event) => event.eventType)).toEqual([
      'tool_call', 'error', 'tool_call', 'error',
    ]);
    expect(JSON.stringify(test.events)).not.toContain(secret);
  });

  it('aynı call replayinde event id, occurredAt ve payloadı birebir korur', async () => {
    const ctx = await context(['read_file']);
    const test = harness();
    const replayed = { callId: id(), occurredAt, name: 'read_file', args: { path: 'a.ts' } } as const;
    await test.executor.execute(ctx, replayed);
    await test.executor.execute(ctx, replayed);
    expect(test.events.slice(2)).toEqual(test.events.slice(0, 2));
    expect(test.events.every((event) => event.toolCallId === replayed.callId)).toBe(true);
  });

  it('aynı callId farklı canonical intent ile tekrar kullanılırsa mutation öncesi reddeder', async () => {
    const ctx = await context(['write_file']);
    const test = harness();
    const callId = id();
    await test.executor.execute(ctx, {
      callId, occurredAt, name: 'write_file', args: { path: 'a.ts', content: 'accepted\n' },
    });
    await expect(test.executor.execute(ctx, {
      callId, occurredAt, name: 'write_file', args: { path: 'a.ts', content: 'divergent\n' },
    })).rejects.toMatchObject({ code: 'CALL_INTENT_CONFLICT' });
    expect(await readFile(path.join(ctx.workspaceRoot, 'a.ts'), 'utf8')).toBe('accepted\n');
    expect(test.events.map((event) => event.eventType)).toEqual([
      'tool_call', 'tool_result', 'tool_call', 'error',
    ]);
    expect(test.events.at(-1)?.payload).toMatchObject({
      errorCode: 'CALL_INTENT_CONFLICT', requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it('write/edit sonrası intent completion yanıtı kaybolursa exact retry post-accept sonucu kurtarır', async () => {
    const writeContext = await context(['write_file']);
    const writeIntent = new DurableIntentFake();
    writeIntent.loseCompleteResponse = true;
    const writer = harness(undefined, undefined, undefined, writeIntent);
    const writeCall = { callId: id(), occurredAt, name: 'write_file', args: { path: 'a.ts', content: 'written\n' } } as const;
    await expect(writer.executor.execute(writeContext, writeCall)).rejects.toThrow('lost complete response');
    expect(await readFile(path.join(writeContext.workspaceRoot, 'a.ts'), 'utf8')).toBe('written\n');
    await expect(writer.executor.execute(writeContext, writeCall)).resolves.toMatchObject({
      value: { written: true },
    });

    const editContext = await context(['edit_file']);
    const editIntent = new DurableIntentFake();
    editIntent.loseCompleteResponse = true;
    const editor = harness(undefined, undefined, undefined, editIntent);
    const editCall = {
      callId: id(), occurredAt, name: 'edit_file', args: { path: 'a.ts', old: 'old', new: 'edited' },
    } as const;
    await expect(editor.executor.execute(editContext, editCall)).rejects.toThrow('lost complete response');
    await expect(editor.executor.execute(editContext, editCall)).resolves.toMatchObject({
      value: { recovered: true },
    });
    expect(await readFile(path.join(editContext.workspaceRoot, 'a.ts'), 'utf8')).toBe('edited\n');
  });

  it('edit_file eşit old/new metnini recovery ile karıştırmadan mutasyon öncesi reddeder', async () => {
    const ctx = await context(['edit_file']);
    const test = harness();
    await expect(test.executor.execute(ctx, {
      callId: id(), occurredAt, name: 'edit_file',
      args: { path: 'a.ts', old: 'old', new: 'old' },
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' });
    expect(await readFile(path.join(ctx.workspaceRoot, 'a.ts'), 'utf8')).toBe('old\n');
  });

  it('uncertain ilk intentte edit mismatchi replay recovery diye yutmaz', async () => {
    const ctx = await context(['edit_file']);
    await writeFile(path.join(ctx.workspaceRoot, 'a.ts'), 'already edited\n');
    const intents: ExecutorIntentPort = {
      accept: vi.fn(async () => ({ state: 'uncertain' as const })),
      complete: vi.fn(async () => undefined),
    };
    const test = harness(undefined, undefined, undefined, intents);
    await expect(test.executor.execute(ctx, {
      callId: id(), occurredAt, name: 'edit_file',
      args: { path: 'a.ts', old: 'old', new: 'edited' },
    })).rejects.toMatchObject({ code: 'EDIT_MISMATCH' });
    expect(await readFile(path.join(ctx.workspaceRoot, 'a.ts'), 'utf8')).toBe('already edited\n');
  });

  it('sandbox yalnız declared targets ve sealed trusted manifestleri görür', async () => {
    const ctx = await context(['run_command']);
    await writeFile(path.join(ctx.workspaceRoot, 'package.json'), '{"private":true}\n');
    await writeFile(path.join(ctx.workspaceRoot, 'undeclared-secret.txt'), 'never-stage-me\n');
    const observed: string[][] = [];
    const sandbox: SandboxPort = {
      run: vi.fn(async (input) => {
        observed.push(input.inputFiles.map((file) => file.path));
        expect(JSON.stringify(input.inputFiles)).not.toContain('never-stage-me');
        return sandboxResult(input);
      }),
      runPipeline: vi.fn(async () => { throw new Error('not used'); }),
    };
    const policy: ExecutorSandboxInputPolicyPort = {
      resolveTrustedInputs: vi.fn(async () => ['package.json']),
    };
    const test = harness(undefined, sandbox, undefined, undefined, policy);
    await test.executor.execute(ctx, {
      callId: id(), occurredAt, name: 'run_command', args: { cmd: 'node', args: ['--version'] },
    });
    expect(observed).toEqual([['a.ts', 'package.json']]);
  });

  it('sandbox base snapshot CAS intervening host değişikliğini ezmeden reddeder', async () => {
    const ctx = await context(['run_command']);
    const sandbox: SandboxPort = {
      run: vi.fn(async (input) => {
        await writeFile(path.join(ctx.workspaceRoot, 'a.ts'), 'intervening\n');
        return sandboxResult(input, {
          mutations: [{ path: 'a.ts', content: 'sandboxed\n', sha256: contentHash('sandboxed\n') }],
        });
      }),
      runPipeline: vi.fn(async () => { throw new Error('not used'); }),
    };
    const test = harness(undefined, sandbox);
    await expect(test.executor.execute(ctx, {
      callId: id(), occurredAt, name: 'run_command', args: { cmd: 'node', args: ['--version'] },
    })).rejects.toMatchObject({ code: 'FILE_CONFLICT' });
    expect(await readFile(path.join(ctx.workspaceRoot, 'a.ts'), 'utf8')).toBe('intervening\n');
  });

  it('durable effect request/result raw argv, stdout ve mutation contenti içermez', async () => {
    const ctx = await context(['run_command']);
    const secret = 'sk-live-super-secret-123456789';
    const persisted: unknown[] = [];
    const effects: ExecutorEffectPort = {
      run: async <T>(effectInput: Parameters<ExecutorEffectPort['run']>[0]) => {
        persisted.push(effectInput.request);
        const live = await effectInput.execute({ externalIdempotencyKey: effectInput.stableEffectId });
        const serialized = effectInput.serialize(live);
        persisted.push(serialized);
        return effectInput.parse(serialized) as T;
      },
    };
    const sandbox: SandboxPort = {
      run: vi.fn(async (sandboxInput) => sandboxResult(sandboxInput, {
        stdout: secret,
        mutations: [{ path: 'a.ts', content: `${secret}\n`, sha256: contentHash(`${secret}\n`) }],
      })),
      runPipeline: vi.fn(async () => { throw new Error('not used'); }),
    };
    const test = harness(undefined, sandbox, effects);
    await test.executor.execute(ctx, {
      callId: id(), occurredAt, name: 'run_command', args: { cmd: 'node', args: ['--token', secret] },
    });
    expect(JSON.stringify(persisted)).not.toContain(secret);
    expect(JSON.stringify(test.events)).not.toContain(secret);
  });

  it('run_commandı exact durable effect kimliğiyle sandboxa verir ve yalnız declared mutationı yayınlar', async () => {
    const ctx = await context(['run_command']);
    const callId = id();
    const captured: Array<Parameters<ExecutorEffectPort['run']>[0]> = [];
    const effects: ExecutorEffectPort = {
      run: async <T>(input: Parameters<ExecutorEffectPort['run']>[0]) => {
        captured.push(input);
        const value = await input.execute({ externalIdempotencyKey: `external:${callId}` });
        return input.parse(input.serialize(value)) as T;
      },
    };
    const sandbox: SandboxPort = {
      run: vi.fn(async (input) => sandboxResult(input, {
        stdout: 'ok', durationMs: 2,
        mutations: [{ path: 'a.ts', content: 'sandboxed\n', sha256: contentHash('sandboxed\n') }],
      })),
      runPipeline: vi.fn(async () => { throw new Error('not used'); }),
    };
    const test = harness(undefined, sandbox, effects);
    const result = await test.executor.execute(ctx, {
      callId, occurredAt, name: 'run_command', args: { cmd: 'node', args: ['--version'] },
    });
    expect(captured[0]).toMatchObject({
      causationId: callId,
      stableEffectId: `executor.run_command.v1:${callId}`,
      replaySafety: 'non_replay_safe',
      createdAt: occurredAt,
      escalationContext: {
        sessionId: ctx.effectEscalation.sessionId,
        owningPmId: ctx.effectEscalation.owningPmId,
        taskBriefId: ctx.brief.taskBriefId,
      },
    });
    expect(result.value).toMatchObject({ exitCode: 0, stdout: '' });
    expect(await readFile(path.join(ctx.workspaceRoot, 'a.ts'), 'utf8')).toBe('sandboxed\n');
  });

  it('çalışan sandbox sırasında fence kaybını abort eder ve mutation yayınlamaz', async () => {
    const ctx = await context(['run_command']);
    let checks = 0;
    let observedAbort = false;
    const access: ExecutorAccessPort = {
      assertAuthorized: vi.fn(async () => {
        checks += 1;
        if (checks >= 3) throw new ExecutorError('LEASE_REQUIRED', 'stale fence');
      }),
    };
    const sandbox: SandboxPort = {
      run: vi.fn(async (input) => await new Promise((resolve, reject) => {
        input.signal?.addEventListener('abort', () => {
          observedAbort = true;
          reject(new Error('aborted'));
        }, { once: true });
        setTimeout(() => resolve(sandboxResult(input, {
          durationMs: 50,
          mutations: [{
            path: 'a.ts', content: 'must not publish', sha256: contentHash('must not publish'),
          }],
        })), 50).unref();
      })),
      runPipeline: vi.fn(async () => { throw new Error('not used'); }),
    };
    const test = harness(access, sandbox);
    await expect(test.executor.execute(ctx, {
      callId: id(), occurredAt, name: 'run_command', args: { cmd: 'node', args: ['--version'] },
    })).rejects.toMatchObject({ code: 'FENCE_LOST' });
    expect(observedAbort).toBe(true);
    expect(await readFile(path.join(ctx.workspaceRoot, 'a.ts'), 'utf8')).toBe('old\n');
  });

  // AS-OF SIZINTISININ MÜHÜRÜ: `memory_query` cutoff'suz koşuyordu. Tek bir
  // tool çağrısı, bütün mühür makinesinin kapattığı zaman sızıntısını
  // yeniden açıyordu: yeniden denenen bir görev, mühürden SONRA yazılmış
  // kararları görebiliyordu.
  it('memory_query mühürlü cutoff ile sorgular', async () => {
    const ctx = await context(['memory_query']);
    const test = harness();
    await test.executor.execute(ctx, {
      callId: id(), occurredAt, name: 'memory_query', args: { question: 'bunu nasil yaptik' },
    });
    expect(test.memory.query).toHaveBeenCalledWith(expect.objectContaining({
      question: 'bunu nasil yaptik',
      cutoffAt: ctx.brief.baseContextCutoffAt,
    }));
  });
});
