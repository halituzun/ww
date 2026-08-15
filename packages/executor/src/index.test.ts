import { describe, expect, it } from 'vitest';

describe('@ww/executor public API', () => {
  it('guarded executor bileşenlerini barrel üzerinden dışa açar', async () => {
    const api = await import('./index.js');
    expect(api).toMatchObject({
      ToolExecutor: expect.any(Function),
      ToolRegistry: expect.any(Function),
      WorkspacePaths: expect.any(Function),
      DockerSandboxAdapter: expect.any(Function),
      GateRunner: expect.any(Function),
      GitWorkspace: expect.any(Function),
      DurableExecutorAudit: expect.any(Function),
      DurableExecutorIntent: expect.any(Function),
      DurableGateCommitAudit: expect.any(Function),
      executorToolRegistry: expect.any(Object),
    });
    expect(api).not.toHaveProperty('CommandRunner');
  });
});
