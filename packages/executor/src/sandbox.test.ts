import { createHash } from 'node:crypto';
import { access, cp, lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DockerSandboxAdapter,
  SandboxError,
  type DockerProcessInput,
  type DockerProcessPort,
  type DockerProcessResult,
  type SandboxCommandInput,
} from './sandbox.js';

const cleanup: string[] = [];
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanup.push(directory);
  return directory;
}

async function exists(target: string): Promise<boolean> {
  try { await access(target); return true; } catch { return false; }
}

function success(overrides: Partial<DockerProcessResult> = {}): DockerProcessResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    truncated: false,
    durationMs: 2,
    ...overrides,
  };
}

class LifecycleDockerProcess implements DockerProcessPort {
  readonly inputs: DockerProcessInput[] = [];
  readonly killed: string[] = [];
  inputRoot = '';

  constructor(
    readonly containerRoot: string,
    readonly onExec: (input: DockerProcessInput, root: string) => Promise<DockerProcessResult> =
      async () => success(),
    readonly onLifecycle?: (input: DockerProcessInput) => DockerProcessResult | undefined,
  ) {}

  async run(input: DockerProcessInput): Promise<DockerProcessResult> {
    this.inputs.push(input);
    const overridden = this.onLifecycle?.(input);
    if (overridden !== undefined) return overridden;
    const action = input.args[0];
    if (action === 'create') {
      const mountIndex = input.args.indexOf('--mount');
      const mount = input.args[mountIndex + 1] ?? '';
      this.inputRoot = /(?:^|,)source=([^,]+)/.exec(mount)?.[1] ?? '';
      return success();
    }
    if (action === 'cp') {
      const source = input.args[1]!;
      const destination = input.args[2]!;
      if (source.includes(':/workspace/')) {
        await cp(this.containerRoot, destination, { recursive: true, force: true });
      }
      return success();
    }
    if (action === 'exec' && input.args.includes('/input/.')) {
      await mkdir(this.containerRoot, { recursive: true });
      await cp(this.inputRoot, this.containerRoot, { recursive: true, force: true });
      return success();
    }
    if (action === 'exec' && input.args.includes('/opt/ww/snapshot.mjs')) {
      const entries: unknown[] = [];
      let totalBytes = 0;
      const marker = input.args.indexOf('/opt/ww/snapshot.mjs');
      const discarded = JSON.parse(Buffer.from(input.args[marker + 1]!, 'base64url').toString('utf8')) as string[];
      const visit = async (directory: string, prefix: string): Promise<void> => {
        for (const name of (await readdir(directory)).sort()) {
          const relativePath = prefix === '' ? name : `${prefix}/${name}`;
          if (discarded.some((item) => relativePath === item || relativePath.startsWith(`${item}/`))) continue;
          const absolute = path.join(directory, name);
          const info = await lstat(absolute);
          const lower = name.toLowerCase();
          if (lower === '.git' || lower === '.env' || lower.startsWith('.env.') ||
            lower === 'secrets' || info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
            entries.push({ path: relativePath, type: 'forbidden' });
          } else if (info.isDirectory()) {
            await visit(absolute, relativePath);
          } else {
            const content = await readFile(absolute);
            totalBytes += content.byteLength;
            entries.push({
              path: relativePath, type: 'file', bytes: content.byteLength,
              sha256: createHash('sha256').update(content).digest('hex'), content: content.toString('base64'),
            });
          }
        }
      };
      await visit(this.containerRoot, '');
      return success({ stdout: JSON.stringify({ version: 1, totalBytes, entries }) });
    }
    if (action === 'exec') return await this.onExec(input, this.containerRoot);
    return success();
  }

  async killContainer(containerName: string): Promise<void> {
    this.killed.push(containerName);
  }
}

function input(overrides: Partial<SandboxCommandInput> = {}): SandboxCommandInput {
  const content = 'before\n';
  return {
    callId: '1f0dc8d5-5d2c-40e8-95cf-1a5d90583a37',
    projectId: 'e769ff8d-922b-4bd9-90bc-e30bef5035b8',
    inputFiles: [{ path: 'src/app.ts', content, sha256: digest(content) }],
    declaredTargets: ['src/app.ts'],
    discardedOutputs: ['node_modules', 'dist'],
    command: 'node',
    args: ['script.js'],
    timeoutMs: 5_000,
    ...overrides,
  };
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(cleanup.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('DockerSandboxAdapter', () => {
  it('yalnız exact inputu kopyalar, host mount/env vermeden hardened bounded container kullanır', async () => {
    const root = await temporaryDirectory('ww-sandbox-unit-');
    const containerRoot = path.join(root, 'container');
    const processPort = new LifecycleDockerProcess(containerRoot, async (_processInput, staged) => {
      expect(await readFile(path.join(staged, 'src/app.ts'), 'utf8')).toBe('before\n');
      expect(await exists(path.join(staged, 'undeclared-secret.txt'))).toBe(false);
      await writeFile(path.join(staged, 'src/app.ts'), 'after\n');
      await mkdir(path.join(staged, 'node_modules'), { recursive: true });
      await writeFile(path.join(staged, 'node_modules/pkg'), 'discarded');
      return success({ stdout: 'ok' });
    });
    const adapter = new DockerSandboxAdapter({
      image: 'node@sha256:abc123',
      processPort,
      tempRoot: path.join(root, 'staging'),
      hostEnv: { PATH: '/safe/bin', DOCKER_HOST: 'unix:///docker.sock', API_KEY: 'never' },
      containerUser: '10001:10001',
      workspaceSize: '32m',
    });
    const result = await adapter.run(input());

    expect(result.baseHashes).toEqual([{ path: 'src/app.ts', sha256: digest('before\n') }]);
    expect(result.mutations).toEqual([{
      path: 'src/app.ts', content: 'after\n', sha256: digest('after\n'),
    }]);
    const create = processPort.inputs.find((item) => item.args[0] === 'create');
    expect(create?.args).toEqual(expect.arrayContaining([
      '--network', 'none', '--read-only',
      '--tmpfs', '/workspace:rw,exec,nosuid,nodev,mode=1777,size=32m',
      '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=512m',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
      '--user', '10001:10001', '--workdir', '/workspace',
    ]));
    const mount = create?.args[(create?.args.indexOf('--mount') ?? -2) + 1];
    expect(mount).toContain('target=/input,readonly');
    expect(mount).not.toContain('/workspace,readonly');
    expect(create?.env).toEqual({ PATH: '/safe/bin', DOCKER_HOST: 'unix:///docker.sock' });
    expect(JSON.stringify(processPort.inputs)).not.toContain('never');
    const exec = processPort.inputs.find((item) => item.args.includes('/opt/ww/run-step.mjs'));
    expect(exec?.args).toEqual(expect.arrayContaining([
      'env', '-i', 'CI=1', 'HOME=/tmp', 'NO_COLOR=1',
      'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      'node', 'script.js',
    ]));
    expect(processPort.killed).toHaveLength(1);
  });

  it('undeclared, silinen, forbidden ve binary mutationları typed scope ihlali yapar', async () => {
    const root = await temporaryDirectory('ww-sandbox-scope-');
    const containerRoot = path.join(root, 'container');
    const processPort = new LifecycleDockerProcess(containerRoot, async (_input, staged) => {
      await writeFile(path.join(staged, 'undeclared.txt'), 'bad');
      await mkdir(path.join(staged, '.GiT'), { recursive: true });
      await writeFile(path.join(staged, '.GiT/config'), 'bad');
      return success();
    });
    const adapter = new DockerSandboxAdapter({
      image: 'ww-executor:test', processPort, tempRoot: path.join(root, 'staging'), containerUser: '10001:10001',
    });
    await expect(adapter.run(input())).rejects.toMatchObject({
      code: 'SANDBOX_SCOPE_VIOLATION',
      details: { paths: ['.GiT', 'undeclared.txt'] },
    });
    expect(processPort.killed).toHaveLength(1);
  });

  it('abort çalışan execi durdurur ve container cleanup ister', async () => {
    const root = await temporaryDirectory('ww-sandbox-abort-');
    const controller = new AbortController();
    const processPort = new LifecycleDockerProcess(path.join(root, 'container'), async (processInput) =>
      await new Promise((_resolve, reject) => {
        processInput.signal?.addEventListener('abort', () => {
          reject(new SandboxError('SANDBOX_ABORTED', 'aborted'));
        }, { once: true });
      }));
    const adapter = new DockerSandboxAdapter({
      image: 'ww-executor:test', processPort, tempRoot: path.join(root, 'staging'), containerUser: '10001:10001',
    });
    const running = adapter.run(input({ signal: controller.signal }));
    while (!processPort.inputs.some((item) => item.args.includes('/opt/ww/run-step.mjs'))) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: 'SANDBOX_ABORTED' });
    expect(processPort.killed).toHaveLength(1);
  });

  it('timeout/truncation sonucunu bounded taşır ve containerı temizler', async () => {
    const root = await temporaryDirectory('ww-sandbox-timeout-');
    const processPort = new LifecycleDockerProcess(path.join(root, 'container'), async () => success({
      exitCode: 137, timedOut: true, truncated: true, stdout: 'bounded',
    }));
    const adapter = new DockerSandboxAdapter({
      image: 'ww-executor:test', processPort, tempRoot: path.join(root, 'staging'), containerUser: '10001:10001',
    });
    await expect(adapter.run(input({ timeoutMs: 10 }))).rejects.toMatchObject({
      code: 'SANDBOX_TIMEOUT', details: { step: 'command', truncated: true },
    });
    expect(processPort.killed).toHaveLength(1);
  });

  it('Docker altyapı hatasını stderr secretı olmadan sınıflandırır', async () => {
    const root = await temporaryDirectory('ww-sandbox-infra-');
    const processPort = new LifecycleDockerProcess(
      path.join(root, 'container'),
      async () => success(),
      (processInput) => processInput.args[0] === 'create'
        ? success({ exitCode: 125, stderr: 'daemon sk-live-super-secret' })
        : undefined,
    );
    const adapter = new DockerSandboxAdapter({
      image: 'ww-executor:test', processPort, tempRoot: path.join(root, 'staging'), containerUser: '10001:10001',
    });
    const error = await adapter.run(input()).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: 'SANDBOX_UNAVAILABLE', details: { exitCode: 125 } });
    expect(JSON.stringify(error)).not.toContain('sk-live');
    expect(processPort.killed).toHaveLength(1);
  });

  it('image, non-root uid, hash, bounded input ve forbidden inputu fail-closed doğrular', async () => {
    expect(() => new DockerSandboxAdapter({ image: '' })).toThrowError(SandboxError);
    expect(() => new DockerSandboxAdapter({ image: 'x', containerUser: '0:1000' })).toThrowError(SandboxError);
    expect(() => new DockerSandboxAdapter({ image: 'x', workspaceSize: 'unlimited' })).toThrowError(SandboxError);
    const root = await temporaryDirectory('ww-sandbox-invalid-');
    const processPort = new LifecycleDockerProcess(path.join(root, 'container'));
    const adapter = new DockerSandboxAdapter({
      image: 'ww-executor:test', processPort, tempRoot: path.join(root, 'staging'), containerUser: '10001:10001',
      maxInputBytes: 4,
    });
    await expect(adapter.run(input())).rejects.toMatchObject({
      code: 'SANDBOX_INPUT_TOO_LARGE', details: { bytes: 7, limit: 4 },
    });
    const countAdapter = new DockerSandboxAdapter({
      image: 'ww-executor:test', processPort, tempRoot: path.join(root, 'staging-count'),
      containerUser: '10001:10001', maxInputFiles: 1,
    });
    await expect(countAdapter.run(input({
      inputFiles: [
        { path: 'src/app.ts', content: 'a', sha256: digest('a') },
        { path: 'src/other.ts', content: 'b', sha256: digest('b') },
      ],
    }))).rejects.toMatchObject({
      code: 'SANDBOX_INPUT_TOO_LARGE', details: { count: 2, limit: 1 },
    });
    await expect(adapter.run(input({
      inputFiles: [{ path: '.ENV', content: 'x', sha256: digest('x') }],
    }))).rejects.toMatchObject({ code: 'SANDBOX_INVALID_ARGUMENT' });
    expect(processPort.inputs).toHaveLength(0);
  });

  it('container cleanup yanıtı gelmezse bounded sürede fail-closed olur ve stagingi siler', async () => {
    const root = await temporaryDirectory('ww-sandbox-cleanup-');
    const lifecycle = new LifecycleDockerProcess(path.join(root, 'container'));
    const processPort: DockerProcessPort = {
      run: (processInput) => lifecycle.run(processInput),
      killContainer: async () => await new Promise<void>(() => undefined),
    };
    const staging = path.join(root, 'staging');
    const adapter = new DockerSandboxAdapter({
      image: 'ww-executor:test', processPort, tempRoot: staging,
      containerUser: '10001:10001', cleanupTimeoutMs: 20,
    });
    await expect(adapter.run(input())).rejects.toMatchObject({ code: 'SANDBOX_CLEANUP_FAILED' });
    expect(await readdir(staging)).toEqual([]);
  });
});
