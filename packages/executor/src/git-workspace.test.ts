import { mkdtemp, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandRunner } from './command-runner.js';
import type { GateEvidence } from './gate-runner.js';
import { GateRunner } from './gate-runner.js';
import { GitWorkspace } from './git-workspace.js';
import { WorkspacePaths } from './workspace-paths.js';
import type {
  CommitAuditInput,
  ExecutorAccessInput,
  ExecutorAccessPort,
  GateCommitAuditPort,
} from './ports.js';

const cleanup: string[] = [];
const projectId = '02345678-1234-4234-8234-123456789012' as const;
const taskId = '12345678-1234-4234-8234-123456789012' as const;
const operationId = '22345678-1234-4234-8234-123456789012' as const;
const briefId = '32345678-1234-4234-8234-123456789012' as const;
const attemptId = '42345678-1234-4234-8234-123456789012' as const;
const agentId = '52345678-1234-4234-8234-123456789012' as const;
const occurredAt = '2026-08-15T10:00:00.000Z';

const access: ExecutorAccessPort = { assertAuthorized: async () => undefined };
const audit = (): GateCommitAuditPort => ({
  appendGate: async () => undefined,
  appendCommit: async () => undefined,
});

function evidence(
  passed = true,
  names: readonly string[] = ['test'],
): GateEvidence {
  return Object.freeze({
    passed,
    configPath: 'ww.gate.json',
    steps: Object.freeze(names.map((name, index) => Object.freeze({
      name,
      index,
      passed: passed || index < names.length - 1,
      command: 'pnpm',
      argumentCount: 0,
      exitCode: passed || index < names.length - 1 ? 0 : 9,
      timedOut: false,
      truncated: false,
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      stderrHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      durationMs: 1,
    }))),
  });
}

function gateRunner(
  gateAudit = audit(),
  run: (projectKey: string, workspace: WorkspacePaths) => Promise<GateEvidence> =
    async () => evidence(),
): GateRunner {
  return { audit: gateAudit, run } as unknown as GateRunner;
}

function targetAccess(
  relativePath = 'target.txt',
  overrides: Partial<ExecutorAccessInput> = {},
): ExecutorAccessInput {
  return {
    projectId,
    taskId,
    taskBriefId: briefId,
    assignmentAttemptId: attemptId,
    agentId,
    taskStatus: 'working',
    leaseOwner: 'scheduler:test',
    leaseFence: 7,
    relativePath,
    requireFileLock: true,
    ...overrides,
  };
}

function commitInput(overrides: Partial<Parameters<GitWorkspace['commitAfterSuccessfulGate']>[1]> = {}) {
  return {
    projectKey: 'test-project',
    operationId,
    occurredAt,
    taskId,
    title: 'target güncelle',
    summary: 'Hedef tamamlandı.',
    workerName: 'Worker',
    verifierName: 'Verifier',
    targetFiles: ['target.txt'],
    targetAccess: [targetAccess()],
    ...overrides,
  };
}

async function gitFixture(options: {
  gate?: GateRunner;
  access?: ExecutorAccessPort;
} = {}): Promise<{
  root: string;
  workspace: WorkspacePaths;
  runner: CommandRunner;
  git: GitWorkspace;
  runGit: (args: readonly string[]) => Promise<string>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ww-git-'));
  cleanup.push(root);
  await writeFile(path.join(root, 'target.txt'), 'initial\n');
  await writeFile(path.join(root, 'unrelated.txt'), 'initial\n');
  await writeFile(path.join(root, 'ww.gate.json'), JSON.stringify({
    version: 1,
    steps: [{ name: 'test', command: 'node', args: ['-e', 'process.exit(0)'] }],
  }));
  const workspace = await new WorkspacePaths(root).initialize();
  const runner = new CommandRunner();
  const runGit = async (args: readonly string[]) => {
    const result = await runner.run({ projectKey: root, command: 'git', args, cwd: root });
    expect(result.exitCode, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  await runGit(['init']);
  await runGit(['config', 'user.name', 'test']);
  await runGit(['config', 'user.email', 'test@example.invalid']);
  await runGit(['add', '--all']);
  await runGit(['commit', '-m', 'initial']);
  return {
    root,
    workspace,
    runner,
    runGit,
    git: new GitWorkspace(runner, options.gate ?? gateRunner(), options.access ?? access),
  };
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('GitWorkspace', () => {
  it('gate geçince yalnız exact task hedefini commit eder ve audit scope’unu bağlar', async () => {
    const commits: CommitAuditInput[] = [];
    const gateAudit: GateCommitAuditPort = {
      appendGate: async () => undefined,
      appendCommit: async (input) => { commits.push(input); },
    };
    const fixture = await gitFixture({ gate: gateRunner(gateAudit) });
    await writeFile(path.join(fixture.root, 'target.txt'), 'task change\n');
    await writeFile(path.join(fixture.root, 'unrelated.txt'), 'user change\n');
    await fixture.runGit(['add', 'unrelated.txt']);

    const result = await fixture.git.commitAfterSuccessfulGate(
      fixture.workspace,
      commitInput({ projectKey: fixture.root }),
    );
    expect(result.commitHash).toBe(await fixture.runGit(['rev-parse', 'HEAD']));
    expect(await fixture.runGit(['show', '--pretty=', '--name-only', 'HEAD'])).toBe('target.txt');
    expect(await fixture.runGit(['status', '--porcelain=v1'])).toContain('M  unrelated.txt');
    expect(commits).toEqual([expect.objectContaining({
      kind: 'task',
      projectId,
      taskId,
      taskBriefId: briefId,
      assignmentAttemptId: attemptId,
      agentId,
      taskStatus: 'working',
      leaseOwner: 'scheduler:test',
      leaseFence: 7,
      targets: ['target.txt'],
      requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      targetFingerprint: result.targetFingerprint,
    })]);
  });

  it('git_diff untracked dosyanın içeriğini bounded döndürür', async () => {
    const { root, workspace, git } = await gitFixture();
    await writeFile(path.join(root, 'new-file.txt'), 'untracked evidence\n');
    const result = await git.diff(root, workspace, ['new-file.txt']);
    expect(result).toMatchObject({ truncated: false });
    expect(result.diff).toContain('new-file.txt');
    expect(result.diff).toContain('+untracked evidence');
  });

  it('git_diff yalnız declared target içeriğini döndürür', async () => {
    const { root, workspace, git } = await gitFixture();
    await writeFile(path.join(root, 'target.txt'), 'declared evidence\n');
    await writeFile(path.join(root, 'unrelated.txt'), 'private unrelated evidence\n');
    const result = await git.diff(root, workspace, ['target.txt']);
    expect(result.diff).toContain('declared evidence');
    expect(result.diff).not.toContain('private unrelated evidence');
    expect(result.diff).not.toContain('unrelated.txt');
  });

  it('gate başarısızken commit veya stage oluşturmaz', async () => {
    const fixture = await gitFixture({ gate: gateRunner(audit(), async () => evidence(false)) });
    const before = await fixture.runGit(['rev-parse', 'HEAD']);
    await writeFile(path.join(fixture.root, 'target.txt'), 'failed task\n');
    await expect(fixture.git.commitAfterSuccessfulGate(
      fixture.workspace,
      commitInput({ projectKey: fixture.root }),
    )).rejects.toMatchObject({ code: 'GATE_FAILED' });
    expect(await fixture.runGit(['rev-parse', 'HEAD'])).toBe(before);
    expect(await fixture.runGit(['diff', '--cached', '--name-only'])).toBe('');
  });

  it('geçersiz scope’u gate, access ve git add öncesinde reddeder', async () => {
    const assertAuthorized = vi.fn(async () => undefined);
    const runGate = vi.fn(async () => evidence());
    const fixture = await gitFixture({
      gate: gateRunner(audit(), runGate),
      access: { assertAuthorized },
    });
    await writeFile(path.join(fixture.root, 'second.txt'), 'second\n');
    await writeFile(path.join(fixture.root, 'target.txt'), 'changed\n');
    const mismatches: readonly Partial<ExecutorAccessInput>[] = [
      { projectId: operationId },
      { taskId: operationId },
      { taskBriefId: operationId },
      { assignmentAttemptId: operationId },
      { agentId: operationId },
      { taskStatus: 'verifying' },
      { leaseOwner: 'scheduler:other' },
      { leaseFence: 8 },
    ];
    for (const mismatch of mismatches) {
      await expect(fixture.git.commitAfterSuccessfulGate(fixture.workspace, commitInput({
        projectKey: fixture.root,
        targetFiles: ['target.txt', './second.txt'],
        targetAccess: [
          targetAccess('target.txt'),
          targetAccess('./second.txt', mismatch),
        ],
      }))).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' });
    }
    expect(assertAuthorized).not.toHaveBeenCalled();
    expect(runGate).not.toHaveBeenCalled();
    expect(await fixture.runGit(['diff', '--cached', '--name-only'])).toBe('');
  });

  it('gate targetı değiştirirse pre-gate fingerprint commit’i durdurur', async () => {
    const fixture = await gitFixture();
    await writeFile(path.join(fixture.root, 'target.txt'), 'expected before gate\n');
    const racingGate = gateRunner(audit(), async () => {
      await writeFile(path.join(fixture.root, 'target.txt'), 'raced in gate\n');
      return evidence();
    });
    fixture.git = new GitWorkspace(fixture.runner, racingGate, access);
    await expect(fixture.git.commitAfterSuccessfulGate(
      fixture.workspace,
      commitInput({ projectKey: fixture.root }),
    )).rejects.toMatchObject({ code: 'GIT_CONFLICT' });
    expect(await fixture.runGit(['diff', '--cached', '--name-only'])).toBe('');
    expect(await fixture.runGit(['rev-list', '--count', 'HEAD'])).toBe('1');
  });

  it('git add sonrası before-commit yarışında eski target ve unrelated stage state’ini exact geri yükler', async () => {
    let calls = 0;
    let root = '';
    const racingAccess: ExecutorAccessPort = {
      assertAuthorized: async () => {
        calls += 1;
        if (calls === 4) await writeFile(path.join(root, 'target.txt'), 'raced before commit\n');
      },
    };
    const fixture = await gitFixture({ access: racingAccess });
    root = fixture.root;
    await writeFile(path.join(root, 'target.txt'), 'preexisting target stage\n');
    await fixture.runGit(['add', 'target.txt']);
    await writeFile(path.join(root, 'target.txt'), 'intended worktree\n');
    await writeFile(path.join(root, 'unrelated.txt'), 'preexisting unrelated stage\n');
    await fixture.runGit(['add', 'unrelated.txt']);
    const targetStageBefore = await fixture.runGit(['show', ':target.txt']);
    const unrelatedStageBefore = await fixture.runGit(['show', ':unrelated.txt']);

    await expect(fixture.git.commitAfterSuccessfulGate(
      fixture.workspace,
      commitInput({ projectKey: root }),
    )).rejects.toMatchObject({ code: 'GIT_CONFLICT' });

    expect(await fixture.runGit(['show', ':target.txt'])).toBe(targetStageBefore);
    expect(await fixture.runGit(['show', ':unrelated.txt'])).toBe(unrelatedStageBefore);
    expect(await fixture.runGit(['rev-list', '--count', 'HEAD'])).toBe('1');
  });

  it('audit accepted-then-throw retryında aynı durable kaydı yazar ve tek commit döndürür', async () => {
    const accepted: CommitAuditInput[] = [];
    let gateRuns = 0;
    const acceptedThenThrow: GateCommitAuditPort = {
      appendGate: async () => undefined,
      appendCommit: async (input) => {
        accepted.push(input);
        if (accepted.length === 1) throw new Error('audit response lost');
      },
    };
    const fixture = await gitFixture({
      gate: gateRunner(acceptedThenThrow, async () => { gateRuns += 1; return evidence(); }),
    });
    await writeFile(path.join(fixture.root, 'target.txt'), 'reconcile me\n');
    const input = commitInput({ projectKey: fixture.root });
    await expect(fixture.git.commitAfterSuccessfulGate(fixture.workspace, input))
      .rejects.toThrow('audit response lost');
    const committed = await fixture.runGit(['rev-parse', 'HEAD']);
    const retried = await fixture.git.commitAfterSuccessfulGate(fixture.workspace, input);
    expect(retried).toMatchObject({ commitHash: committed, gate: null, reconciled: true });
    expect(await fixture.runGit(['rev-list', '--count', 'HEAD'])).toBe('2');
    expect(gateRuns).toBe(1);
    expect(accepted).toHaveLength(2);
    expect(accepted[1]).toEqual(accepted[0]);
  });

  it('reconcile current target dirty veya committed fingerprint’ten divergent ise fail-closed davranır', async () => {
    let commitAudits = 0;
    const failingAudit: GateCommitAuditPort = {
      appendGate: async () => undefined,
      appendCommit: async () => {
        commitAudits += 1;
        if (commitAudits === 1) throw new Error('audit unavailable');
      },
    };
    const fixture = await gitFixture({ gate: gateRunner(failingAudit) });
    await writeFile(path.join(fixture.root, 'target.txt'), 'committed target\n');
    const input = commitInput({ projectKey: fixture.root });
    await expect(fixture.git.commitAfterSuccessfulGate(fixture.workspace, input)).rejects.toThrow('audit unavailable');

    await fixture.runGit(['update-index', '--chmod=+x', 'target.txt']);
    await expect(fixture.git.commitAfterSuccessfulGate(fixture.workspace, input))
      .rejects.toMatchObject({ code: 'GIT_CONFLICT' });
    await fixture.runGit(['update-index', '--chmod=-x', 'target.txt']);

    await writeFile(path.join(fixture.root, 'target.txt'), 'divergent dirty target\n');
    await expect(fixture.git.commitAfterSuccessfulGate(fixture.workspace, input))
      .rejects.toMatchObject({ code: 'GIT_CONFLICT' });
    expect(commitAudits).toBe(1);
    expect(await fixture.runGit(['rev-list', '--count', 'HEAD'])).toBe('2');
  });

  it('ayrı GitWorkspace örneklerinin mutasyonlarını workspace bazında serialize eder', async () => {
    const fixture = await gitFixture();
    await writeFile(path.join(fixture.root, 'other-target.txt'), 'initial\n');
    await fixture.runGit(['add', 'other-target.txt']);
    await fixture.runGit(['commit', '-m', 'second baseline']);
    await writeFile(path.join(fixture.root, 'target.txt'), 'one\n');
    await writeFile(path.join(fixture.root, 'other-target.txt'), 'two\n');
    const otherOperation = '62345678-1234-4234-8234-123456789012' as const;
    const second = new GitWorkspace(fixture.runner, gateRunner(), access);
    const [firstResult, secondResult] = await Promise.all([
      fixture.git.commitAfterSuccessfulGate(
        fixture.workspace,
        commitInput({ projectKey: fixture.root }),
      ),
      second.commitAfterSuccessfulGate(fixture.workspace, commitInput({
        projectKey: fixture.root,
        operationId: otherOperation,
        targetFiles: ['other-target.txt'],
        targetAccess: [targetAccess('other-target.txt')],
      })),
    ]);
    expect(firstResult.commitHash).not.toBe(secondResult.commitHash);
    expect(await fixture.runGit(['status', '--porcelain=v1'])).toBe('');
  });

  it('packaged starterı yayınlar, sonra durable audit yazar ve packaged gitignore kullanır', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ww-starter-'));
    cleanup.push(root);
    const canonicalRoot = await realpath(root);
    const runner = new CommandRunner();
    let publishedBeforeAudit = false;
    const gateAudit: GateCommitAuditPort = {
      appendGate: async () => undefined,
      appendCommit: async (input) => {
        publishedBeforeAudit = (await stat(path.join(root, '.git'))).isDirectory();
        expect(input).toMatchObject({ kind: 'starter', projectKey: canonicalRoot, reconciled: false });
      },
    };
    const starterGate = gateRunner(gateAudit, async () => evidence(true, [
      'install', 'typecheck', 'lint', 'test', 'build',
    ]));
    const result = await new GitWorkspace(runner, starterGate, access)
      .initializeWebStarter(root, { operationId, occurredAt });
    expect(publishedBeforeAudit).toBe(true);
    expect(result).toMatchObject({ gate: { passed: true }, reconciled: false });
    expect(await readFile(path.join(root, '.gitignore'), 'utf8')).toContain('node_modules/');
    await expect(readFile(path.join(root, 'gitignore.template'), 'utf8')).rejects.toBeDefined();
    expect(await readdir(root)).not.toContain('node_modules');
  });

  it('starter audit crash sonrası exact published commit’i gatesiz reconcile eder', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ww-starter-reconcile-'));
    cleanup.push(root);
    const runner = new CommandRunner();
    const accepted: CommitAuditInput[] = [];
    let gateRuns = 0;
    const gateAudit: GateCommitAuditPort = {
      appendGate: async () => undefined,
      appendCommit: async (input) => {
        accepted.push(input);
        if (accepted.length === 1) throw new Error('starter audit response lost');
      },
    };
    const git = new GitWorkspace(runner, gateRunner(gateAudit, async () => {
      gateRuns += 1;
      return evidence(true, ['install', 'typecheck', 'lint', 'test', 'build']);
    }), access);
    await expect(git.initializeWebStarter(root, { operationId, occurredAt }))
      .rejects.toThrow('starter audit response lost');
    const firstHash = (await runner.run({
      projectKey: root,
      command: 'git',
      args: ['rev-parse', 'HEAD'],
      cwd: root,
    })).stdout.trim();
    const retried = await git.initializeWebStarter(root, { operationId, occurredAt });
    expect(retried).toMatchObject({ commitHash: firstHash, gate: null, reconciled: true });
    expect(gateRuns).toBe(1);
    expect(accepted[1]).toEqual(accepted[0]);

    await writeFile(path.join(root, '.env'), 'post-crash drift\n');
    await expect(git.initializeWebStarter(root, { operationId, occurredAt }))
      .rejects.toMatchObject({ code: 'GIT_CONFLICT' });
  });

  it('starter install gate başarısızlığında hedefi boş bırakır', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ww-starter-fail-'));
    cleanup.push(root);
    const runner = new CommandRunner();
    const git = new GitWorkspace(
      runner,
      gateRunner(audit(), async () => evidence(false, ['install'])),
      access,
    );
    await expect(git.initializeWebStarter(root, { operationId, occurredAt }))
      .rejects.toMatchObject({ code: 'GATE_FAILED' });
    expect(await readdir(root)).toEqual([]);
  });
});
