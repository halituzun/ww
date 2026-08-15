import { access, mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CommandRunner } from './command-runner.js';

const cleanup: string[] = [];

async function temp(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ww-command-'));
  cleanup.push(directory);
  return directory;
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('CommandRunner', () => {
  it('shell injection biçimli argümanı literal geçirir', async () => {
    const root = await temp();
    const marker = path.join(root, 'injected');
    const runner = new CommandRunner({ allowedCommands: ['node'] });
    const result = await runner.run({
      projectKey: 'p', command: 'node', cwd: root,
      args: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', `;touch ${marker}`],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`;touch ${marker}`);
    await expect(access(marker)).rejects.toBeDefined();
  });

  it('izin listesi dışındaki komutu reddeder', async () => {
    const root = await temp();
    const runner = new CommandRunner({ allowedCommands: ['node'] });
    await expect(runner.run({ projectKey: 'p', command: 'git', args: [], cwd: root }))
      .rejects.toMatchObject({ code: 'COMMAND_NOT_ALLOWED' });
  });

  it('varsayılan privileged host adapter project scriptlerini çalıştırmaz', async () => {
    const root = await temp();
    const runner = new CommandRunner();
    await expect(runner.run({ projectKey: 'p', command: 'node', args: ['-e', ''], cwd: root }))
      .rejects.toMatchObject({ code: 'COMMAND_NOT_ALLOWED' });
    expect(runner.isAllowed('git')).toBe(true);
  });

  it('allowlistte olup hostta bulunmayan binaryyi unavailable sınıflandırır', async () => {
    const root = await temp();
    const command = 'ww-definitely-missing-binary';
    const runner = new CommandRunner({ allowedCommands: [command] });
    await expect(runner.run({ projectKey: 'p', command, args: [], cwd: root }))
      .rejects.toMatchObject({ code: 'COMMAND_UNAVAILABLE', details: { errorCode: 'ENOENT' } });
  });

  it('host command varsayılan ortamına server secretlarını taşımaz', async () => {
    const root = await temp();
    const secretName = 'WW_EXECUTOR_TEST_SERVER_SECRET';
    process.env[secretName] = 'must-not-leak';
    try {
      const result = await new CommandRunner({ allowedCommands: ['node'] }).run({
        projectKey: 'p', command: 'node', cwd: root,
        args: ['-e', `process.stdout.write(process.env.${secretName} ?? '')`],
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
    } finally {
      delete process.env[secretName];
    }
  });

  it('toplam stdout/stderr çıktısını byte sınırında kırpar', async () => {
    const root = await temp();
    const runner = new CommandRunner({ allowedCommands: ['node'], maxOutputBytes: 32 });
    const result = await runner.run({
      projectKey: 'p', command: 'node', cwd: root,
      args: ['-e', 'process.stdout.write("a".repeat(100));process.stderr.write("b".repeat(100))'],
    });
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBe(32);
  });

  it('timeoutta tüm process grubunu öldürür', async () => {
    const root = await temp();
    const marker = path.join(root, 'child-finished');
    const runner = new CommandRunner({ allowedCommands: ['node'], defaultTimeoutMs: 100 });
    const source = [
      'const {spawn}=require("node:child_process")',
      `spawn(process.execPath,["-e",${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'x'),600)`) }],{stdio:"ignore"})`,
      'setInterval(()=>{},1000)',
    ].join(';');
    const result = await runner.run({ projectKey: 'p', command: 'node', args: ['-e', source], cwd: root });
    expect(result.timedOut).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 800));
    await expect(readFile(marker, 'utf8')).rejects.toBeDefined();
  });

  it('proje başına eşzamanlılık sınırını zorlar ve slotu geri bırakır', async () => {
    const root = await temp();
    const runner = new CommandRunner({ allowedCommands: ['node'], maxConcurrentPerProject: 1 });
    const first = runner.run({
      projectKey: 'p', command: 'node', args: ['-e', 'setTimeout(()=>{},150)'], cwd: root,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(runner.run({ projectKey: 'p', command: 'node', args: ['-e', ''], cwd: root }))
      .rejects.toMatchObject({ code: 'COMMAND_CONCURRENCY_LIMIT' });
    await first;
    await expect(runner.run({ projectKey: 'p', command: 'node', args: ['-e', ''], cwd: root }))
      .resolves.toMatchObject({ exitCode: 0 });
  });
});
