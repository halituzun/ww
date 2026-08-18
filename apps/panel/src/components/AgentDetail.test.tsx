// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { AgentDetail } from './AgentDetail.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const respond = (body: unknown, ok = true, status = 200) => ({
  ok, status,
  headers: new Headers({ 'content-type': 'application/json' }),
  text: async () => JSON.stringify(body),
});

const detail = {
  agentId: 'a1', name: 'Worker 1', role: 'worker', group: 'coding',
  modelRef: 'deepseek:deepseek-chat', status: 'idle', tasksDone: 2, tasksRejected: 0,
  tasks: [{ taskId: 't1', title: 'Todo tipleri', status: 'done', relation: 'worker' }],
  messageCount: 4, promptTokens: 1000, completionTokens: 500, costUsd: 0.0063, calls: 8,
};

describe('AgentDetail', () => {
  it('agent secilmediginde yonlendirici ipucu gosterir', () => {
    render(<AgentDetail projectId="p1" agentId={undefined} />);
    expect(screen.getByText(/bir agent seçin/i)).toBeDefined();
  });

  // docs/08: "görevleri, mesajları, harcadığı token".
  it('gorev mesaj ve harcamayi gosterir', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond(detail) as never);
    render(<AgentDetail projectId="p1" agentId="a1" />);

    await waitFor(() => expect(screen.getByText('Worker 1')).toBeDefined());
    expect(screen.getByText('$0.0063')).toBeDefined();
    expect(screen.getByText('1500')).toBeDefined();
    expect(screen.getByText('4')).toBeDefined();
  });

  it('gorevi hangi rolde yaptigini yazar', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond(detail) as never);
    render(<AgentDetail projectId="p1" agentId="a1" />);
    await waitFor(() => expect(screen.getByText('yaptı')).toBeDefined());
  });

  it('gorev yoksa bunu acikca soyler', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond({ ...detail, tasks: [] }) as never);
    render(<AgentDetail projectId="p1" agentId="a1" />);
    await waitFor(() => expect(screen.getByText(/hiçbir göreve bağlanmadı/i)).toBeDefined());
  });

  // Hata yutulursa boş panel "bu agent hiçbir şey yapmadı" yalanını söyler.
  it('hata durumunda bos panel gostermez', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      respond({ message: 'agent bulunamadi' }, false, 404) as never);
    render(<AgentDetail projectId="p1" agentId="a1" />);
    await waitFor(() => expect(screen.getByText(/agent bulunamadi|Agent geçmişi/)).toBeDefined());
  });
});
