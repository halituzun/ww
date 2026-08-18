import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GATE_FAILURE_OUTPUT_LIMIT, GateRunner, parseGateConfig, type GateInputPolicyPort,
} from './gate-runner.js';
import type { GateCommitAuditPort, GateAuditInput } from './ports.js';
import type {
  SandboxCommandResult,
  SandboxPipelineInput,
  SandboxPipelineResult,
  SandboxPort,
  SandboxStepResult,
} from './sandbox.js';
import { WorkspacePaths } from './workspace-paths.js';

const cleanup: string[] = [];
const operationId = '12345678-1234-4234-8234-123456789012' as const;
const occurredAt = '2026-08-15T10:00:00.000Z';

function config(steps: readonly Readonly<{ name: string; command?: string; args?: readonly string[] }>[]) {
  return {
    version: 1,
    inputs: ['package.json'],
    discardedOutputs: ['node_modules', 'dist'],
    steps: steps.map((step) => ({
      name: step.name,
      command: step.command ?? 'node',
      args: step.args ?? ['--version'],
    })),
  };
}

async function fixture(value: unknown): Promise<{ root: string; workspace: WorkspacePaths }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ww-gate-'));
  cleanup.push(root);
  await writeFile(path.join(root, 'ww.gate.json'), JSON.stringify(value));
  await writeFile(path.join(root, 'package.json'), '{"private":true}\n');
  await writeFile(path.join(root, 'undeclared-secret.txt'), 'sk-live-never-stage\n');
  return { root, workspace: await new WorkspacePaths(root).initialize() };
}

class FakeSandbox implements SandboxPort {
  readonly calls: SandboxPipelineInput[] = [];
  constructor(readonly failingStep?: string, readonly output = '') {}

  async run(): Promise<SandboxCommandResult> {
    throw new Error('GateRunner must use runPipeline');
  }

  async runPipeline(input: SandboxPipelineInput): Promise<SandboxPipelineResult> {
    this.calls.push(input);
    const results: SandboxStepResult[] = [];
    for (const step of input.steps) {
      const failed = step.name === this.failingStep;
      results.push({
        ...step,
        exitCode: failed ? 5 : 0,
        signal: null,
        stdout: this.output,
        stderr: failed ? this.output : '',
        timedOut: false,
        truncated: false,
        durationMs: 2,
      });
      if (failed) break;
    }
    return { baseHashes: [], steps: results, mutations: [] };
  }
}

function ports() {
  const records: GateAuditInput[] = [];
  const audit: GateCommitAuditPort = {
    appendGate: vi.fn(async (input) => { records.push(input); }),
    appendCommit: vi.fn(async () => undefined),
  };
  const policy: GateInputPolicyPort = { assertAllowed: vi.fn(async () => undefined) };
  return { records, audit, policy };
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(cleanup.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('GateRunner', () => {
  it('sealed exact girdileri tek sandbox pipeline içinde ilan edilen sırada çalıştırır', async () => {
    const { workspace } = await fixture(config([
      { name: 'install', command: 'pnpm', args: ['install', '--frozen-lockfile'] },
      { name: 'test', command: 'pnpm', args: ['test'] },
      { name: 'build', command: 'pnpm', args: ['build'] },
    ]));
    const sandbox = new FakeSandbox();
    const { records, audit, policy } = ports();
    const result = await new GateRunner(sandbox, audit, policy)
      .run('project', workspace, { operationId, occurredAt });

    expect(result.passed).toBe(true);
    expect(sandbox.calls).toHaveLength(1);
    expect(sandbox.calls[0]?.steps.map((step) => step.name)).toEqual(['install', 'test', 'build']);
    expect(sandbox.calls[0]?.inputFiles.map((file) => file.path).sort()).toEqual([
      'package.json', 'ww.gate.json',
    ]);
    expect(JSON.stringify(sandbox.calls)).not.toContain('sk-live-never-stage');
    expect(sandbox.calls[0]?.discardedOutputs).toEqual(['node_modules', 'dist']);
    expect(policy.assertAllowed).toHaveBeenCalledWith(expect.objectContaining({
      projectKey: 'project', inputs: ['package.json'], discardedOutputs: ['node_modules', 'dist'],
      configHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(records.map((item) => item.step.name)).toEqual(['install', 'test', 'build']);
  });

  it('ilk başarısız adımda durur ve sonraki adımı çalıştırmaz', async () => {
    const { workspace } = await fixture(config([{ name: 'fail' }, { name: 'never' }]));
    const sandbox = new FakeSandbox('fail');
    const { audit, policy } = ports();
    const result = await new GateRunner(sandbox, audit, policy)
      .run('project', workspace, { operationId, occurredAt });
    expect(result.passed).toBe(false);
    expect(result.steps.map((step) => step.name)).toEqual(['fail']);
  });

  it('kapalı config, canonical input, duplicate ad ve git komutunu fail-closed reddeder', () => {
    expect(() => parseGateConfig({ ...config([{ name: 'one' }]), extra: true })).toThrow(/kapalı/);
    expect(() => parseGateConfig({ ...config([{ name: 'one' }]), inputs: ['./package.json'] }))
      .toThrow(/canonical/);
    expect(() => parseGateConfig(config([{ name: 'same' }, { name: 'same' }])))
      .toThrow(/geçersiz/);
    expect(() => parseGateConfig(config([{ name: 'git', command: 'git' }])))
      .toThrow(expect.objectContaining({ code: 'COMMAND_NOT_ALLOWED' }));
  });

  it('ham stdout/stderr yerine yalnız bounded hash ve sayaçları durable audit eder', async () => {
    const secret = 'sk-live-super-secret-123456789';
    const { workspace } = await fixture(config([{ name: 'fail' }]));
    const sandbox = new FakeSandbox('fail', secret);
    const { records, audit, policy } = ports();
    const result = await new GateRunner(sandbox, audit, policy)
      .run('project', workspace, { operationId, occurredAt });
    expect(result.steps[0]).toEqual(expect.objectContaining({
      stdoutBytes: Buffer.byteLength(secret), stdoutHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(records[0]).toEqual(expect.objectContaining({
      operationId,
      occurredAt,
      step: expect.objectContaining({ name: 'fail', passed: false, exitCode: 5 }),
    }));
    expect(JSON.stringify(records)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  // docs/05: "Hata → TAM ÇIKTI worker'a döner". Dönmüyordu: kapı yalnızca
  // hash tutuyor, worker'a giden tek şey "gate_step:tsc:failed:1" oluyordu.
  // Worker göremediği bir hatayı düzeltmeye çağrılıyordu.
  //
  // Çıktı KANIT'a değil, ayrı ve açıkça istenen bir kanala verilir: kanıt
  // kalıcı kayda gider ve ham çıktı taşımaması KASITLI bir değişmezdir.
  it('dusen adimin ciktisini ayri kanaldan verir, kanita KOYMAZ', async () => {
    const { workspace } = await fixture(config([{ name: 'tsc' }]));
    const sandbox = new FakeSandbox('tsc', "src/Board.tsx(4,7): error TS2304: Cannot find name 'Squares'.");
    const { audit, policy, records } = ports();
    const seen: { name: string; output: string }[] = [];

    const result = await new GateRunner(sandbox, audit, policy).run('project', workspace, {
      operationId, occurredAt,
      onStepFailure: (failure) => { seen.push({ name: failure.name, output: failure.output }); },
    });

    expect(result.passed).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.name).toBe('tsc');
    expect(seen[0]!.output).toContain('TS2304');
    // Kanıt ve kalıcı kayıt eskisi gibi ham çıktıdan arınmış kalır.
    expect(JSON.stringify(result)).not.toContain('TS2304');
    expect(JSON.stringify(records)).not.toContain('TS2304');
  });

  it('gecen adim icin cikti kanali cagrilmaz', async () => {
    const { workspace } = await fixture(config([{ name: 'tsc' }]));
    const sandbox = new FakeSandbox(undefined, 'her sey yolunda');
    const { audit, policy } = ports();
    const seen: unknown[] = [];

    await new GateRunner(sandbox, audit, policy).run('project', workspace, {
      operationId, occurredAt, onStepFailure: (failure) => { seen.push(failure); },
    });
    expect(seen).toEqual([]);
  });

  // Kanal worker prompt'una gider: anahtar sızarsa modele ve `tasks`
  // kaydına sızar. Sınır da şart — 200 bin satırlık test çıktısı prompt'u
  // boğar ve asıl hatayı görünmez yapar.
  it('cikti kanalini redakte eder ve sonunu tutarak sinirlar', async () => {
    const secret = 'sk-live-super-secret-123456789';
    const noise = 'x'.repeat(10_000);
    const { workspace } = await fixture(config([{ name: 'test' }]));
    const sandbox = new FakeSandbox('test', `${secret}\n${noise}\nSON SATIR: assertion failed`);
    const { audit, policy } = ports();
    let captured = '';

    await new GateRunner(sandbox, audit, policy).run('project', workspace, {
      operationId, occurredAt, onStepFailure: (failure) => { captured = failure.output; },
    });

    expect(captured).not.toContain(secret);
    expect(captured.length).toBeLessThanOrEqual(GATE_FAILURE_OUTPUT_LIMIT);
    // Hata genelde SONDA olur; baştan kırpmak tam da aranan satırı atardı.
    expect(captured).toContain('SON SATIR: assertion failed');
  });

  it('audit kabul edip yanıtı kaybederse exact retry audit tarafından reconcile edilir', async () => {
    const { workspace } = await fixture(config([{ name: 'test' }]));
    const sandbox = new FakeSandbox();
    const accepted = new Map<string, string>();
    let loseFirstResponse = true;
    const audit: GateCommitAuditPort = {
      appendGate: async (input) => {
        const key = `${input.operationId}:${input.step.index}`;
        const serialized = JSON.stringify(input);
        const existing = accepted.get(key);
        if (existing !== undefined && existing !== serialized) throw new Error('divergent audit');
        accepted.set(key, serialized);
        if (loseFirstResponse) { loseFirstResponse = false; throw new Error('lost response'); }
      },
      appendCommit: async () => undefined,
    };
    const policy: GateInputPolicyPort = { assertAllowed: async () => undefined };
    const runner = new GateRunner(sandbox, audit, policy);
    await expect(runner.run('project', workspace, { operationId, occurredAt })).rejects.toThrow('lost response');
    await expect(runner.run('project', workspace, { operationId, occurredAt })).resolves.toMatchObject({ passed: true });
    expect(accepted.size).toBe(1);
  });
});
