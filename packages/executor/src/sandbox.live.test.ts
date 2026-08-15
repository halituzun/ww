import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { CommandRunner } from './command-runner.js';
import { GateRunner } from './gate-runner.js';
import { GitWorkspace } from './git-workspace.js';
import { DockerSandboxAdapter } from './sandbox.js';

const live = process.env['WW_DOCKER_LIVE'] === '1';
const image = process.env['WW_EXECUTOR_IMAGE'] ?? 'ww-executor-runtime:test';
const execFileAsync = promisify(execFile);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const callId = '71345678-1234-4234-8234-123456789012';
const projectId = '81345678-1234-4234-8234-123456789012';

function nameFor(id: string): string {
  return `ww-sandbox-${digest(id).slice(0, 32)}`;
}

async function expectRemoved(id: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await execFileAsync('docker', ['container', 'inspect', nameFor(id)]);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`sandbox container cleanup did not finish: ${nameFor(id)}`);
}

describe.runIf(live)('DockerSandboxAdapter live isolation', () => {
  it('non-root, env-clean, cap-drop, network-none ve tmpfs workspace içinde exact input çalıştırır', async () => {
    const source = `
      const fs = require('node:fs');
      const status = fs.readFileSync('/proc/self/status', 'utf8');
      const mount = fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\\n')
        .find((line) => line.includes(' /workspace '));
      fs.writeFileSync('out.txt', 'sandboxed\\n');
      console.log(JSON.stringify({
        uid: process.getuid(), gid: process.getgid(),
        env: Object.keys(process.env).sort(),
        interfaces: fs.readdirSync('/sys/class/net').sort(),
        route: fs.readFileSync('/proc/net/route', 'utf8'),
        capEff: /CapEff:\\s+([0-9a-f]+)/i.exec(status)?.[1],
        mount,
        undeclared: fs.existsSync('undeclared-secret.txt'),
      }));
    `;
    const adapter = new DockerSandboxAdapter({
      image,
      networkMode: 'none',
      containerUser: '10001:10001',
      workspaceSize: '16m',
    });
    const result = await adapter.run({
      callId,
      projectId,
      inputFiles: [{ path: 'probe.cjs', content: source, sha256: digest(source) }],
      declaredTargets: ['out.txt'],
      command: 'node',
      args: ['probe.cjs'],
      timeoutMs: 10_000,
    });
    const observed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(observed).toMatchObject({
      uid: 10001,
      gid: 10001,
      env: ['CI', 'HOME', 'NO_COLOR', 'PATH'],
      capEff: '0000000000000000',
      undeclared: false,
    });
    expect(observed['interfaces']).toEqual(expect.arrayContaining(['lo']));
    expect(String(observed['route'])).not.toMatch(/\t00000000\t/);
    expect(String(observed['mount'])).toContain(' - tmpfs tmpfs ');
    expect(String(observed['mount'])).not.toContain('noexec');
    expect(result.mutations).toEqual([{
      path: 'out.txt', content: 'sandboxed\n', sha256: digest('sandboxed\n'),
    }]);
    await expectRemoved(callId);
  }, 30_000);

  it('output, disk, timeout ve abort sınırlarında process/container cleanup yapar', async () => {
    const outputId = '72345678-1234-4234-8234-123456789012';
    const bounded = new DockerSandboxAdapter({ image, maxOutputBytes: 128, workspaceSize: '16m' });
    const output = await bounded.run({
      callId: outputId, projectId, inputFiles: [], declaredTargets: [],
      command: 'node', args: ['-e', "process.stdout.write('x'.repeat(10000))"], timeoutMs: 10_000,
    });
    expect(output.truncated).toBe(true);
    expect(Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr)).toBeLessThanOrEqual(128);
    await expectRemoved(outputId);

    const diskId = '73345678-1234-4234-8234-123456789012';
    const disk = new DockerSandboxAdapter({ image, workspaceSize: '1m' });
    const diskResult = await disk.run({
      callId: diskId, projectId, inputFiles: [], declaredTargets: [], discardedOutputs: ['node_modules'],
      command: 'node',
      args: ['-e', "const f=require('node:fs');f.mkdirSync('node_modules');try{f.writeFileSync('node_modules/big',Buffer.alloc(4*1024*1024));}catch{process.exit(23)}"],
      timeoutMs: 10_000,
    });
    expect(diskResult.exitCode).toBe(23);
    await expectRemoved(diskId);

    const timeoutId = '74345678-1234-4234-8234-123456789012';
    await expect(new DockerSandboxAdapter({ image }).run({
      callId: timeoutId, projectId, inputFiles: [], declaredTargets: [],
      command: 'node', args: ['-e', 'setInterval(() => undefined, 1000)'], timeoutMs: 75,
    })).rejects.toMatchObject({ code: 'SANDBOX_TIMEOUT' });
    await expectRemoved(timeoutId);

    const abortId = '75345678-1234-4234-8234-123456789012';
    const controller = new AbortController();
    const aborted = new DockerSandboxAdapter({ image }).run({
      callId: abortId, projectId, inputFiles: [], declaredTargets: [],
      command: 'node', args: ['-e', 'setInterval(() => undefined, 1000)'], timeoutMs: 10_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    await expect(aborted).rejects.toMatchObject({ code: 'SANDBOX_ABORTED' });
    await expectRemoved(abortId);
  }, 60_000);

  it('starterı atomik materialize eder, frozen gate zincirini sandboxta geçirir ve temiz Git commiti kurar', async () => {
    const destination = await mkdtemp(path.join(os.tmpdir(), 'ww-starter-live-'));
    const audits: unknown[] = [];
    const gate = new GateRunner(
      new DockerSandboxAdapter({ image, networkMode: 'bridge', workspaceSize: '768m', maxOutputBytes: 2_097_152 }),
      {
        appendGate: async (value) => { audits.push(value); },
        appendCommit: async (value) => { audits.push(value); },
      },
      { assertAllowed: async () => undefined },
    );
    try {
      const result = await new GitWorkspace(
        new CommandRunner(),
        gate,
        { assertAuthorized: async () => undefined },
      ).initializeWebStarter(destination, {
        operationId: '76345678-1234-4234-8234-123456789012',
        occurredAt: '2026-08-15T10:00:00.000Z',
      });
      expect(result.gate.passed).toBe(true);
      expect(result.gate.steps.map((step) => step.name)).toEqual(['install', 'typecheck', 'lint', 'test', 'build']);
      expect((await execFileAsync('git', ['-C', destination, 'status', '--porcelain'])).stdout).toBe('');
      expect((await execFileAsync('git', ['-C', destination, 'rev-parse', 'HEAD'])).stdout.trim())
        .toBe(result.commitHash);
      expect(await readFile(path.join(destination, '.gitignore'), 'utf8')).toContain('node_modules/');
      expect(JSON.stringify(audits)).not.toContain('TaskList');
      await expectRemoved('76345678-1234-4234-8234-123456789012');
    } finally {
      await rm(destination, { recursive: true, force: true });
    }
  }, 180_000);
});
