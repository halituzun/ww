import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCh, runMigrations, clickhouseUp, type ClickHouseClient } from '@ww/db';
import { createClickHouseBrakePorts } from './brake-ports.js';
import { createBrakeGuard } from './brake-guard.js';

const up = await clickhouseUp();

describe.skipIf(!up)('createClickHouseBrakePorts', () => {
  const db = `ww_test_brakeports_${Date.now()}`;
  const projectId = randomUUID();
  const taskId = randomUUID();
  const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
  let ch: ClickHouseClient;

  beforeAll(async () => {
    await runMigrations({ database: db });
    ch = createCh({ database: db });

    await ch.insert({
      table: 'projects',
      values: [{
        project_id: projectId, name: 'fren', slug: 'fren', type: 'web', status: 'running',
        budget_usd_limit: 10, created_at: startedAt, updated_at: startedAt, version: 1,
      }],
      format: 'JSONEachRow',
    });

    const base = {
      task_id: taskId, project_id: projectId, title: 'fren testi', status: 'working',
      issuer_agent_id: randomUUID(), token_budget: 1000, tokens_spent: 250,
      created_at: startedAt, updated_at: startedAt,
    };
    await ch.insert({
      table: 'tasks',
      values: [
        { ...base, reject_reason: 'aynı hata: null pointer', version: 1 },
        { ...base, reject_reason: 'aynı hata: null pointer', version: 3, tokens_spent: 400 },
      ],
      format: 'JSONEachRow',
    });

    // Ret geçmişi append-only events'ten okunur: tasks ReplacingMergeTree
    // olduğu için birleştirme eski sürümleri siler ve geçmiş kaybolur.
    await ch.insert({
      table: 'events',
      values: [1, 2, 3].map((n) => ({
        event_id: randomUUID(), seq: String(n), project_id: projectId, task_id: taskId,
        agent_id: randomUUID(), event_type: 'status_change', tool_name: '',
        payload: JSON.stringify({ action: 'verifier_rejected', reason: 'aynı hata: null pointer at line 12' }),
        duration_ms: 0, created_at: new Date(Date.now() - n * 1000).toISOString(),
      })),
      format: 'JSONEachRow',
    });

    await ch.insert({
      table: 'api_usage',
      values: [{
        usage_id: randomUUID(), project_id: projectId, task_id: taskId,
        provider_id: 'deepseek', model: 'deepseek-chat', purpose: 'completion',
        prompt_tokens: 100, completion_tokens: 50, cost_usd: 3, latency_ms: 10,
        status: 'ok', error_kind: '', created_at: startedAt,
      }],
      format: 'JSONEachRow',
    });
  });

  afterAll(async () => {
    const admin = createCh({ database: 'default' });
    await admin.command({ query: `DROP DATABASE IF EXISTS ${db}` });
    await admin.close();
    await ch.close();
  });

  it('görevin son sürümündeki token bütçesini ve başlangıç anını okur', async () => {
    const ports = createClickHouseBrakePorts(ch);
    const budget = await ports.readTaskBudget(taskId);
    expect(budget.tokenBudget).toBe(1000);
    expect(budget.tokensSpent).toBe(400); // en yüksek sürüm kazanır
    expect(budget.startedAtMs).toBe(Date.parse(startedAt));
  });

  it('projenin harcamasını ve limitini görev üzerinden bulur', async () => {
    const ports = createClickHouseBrakePorts(ch);
    const spend = await ports.readProjectSpend(taskId);
    expect(spend.spentUsd).toBeCloseTo(3, 6);
    expect(spend.limitUsd).toBe(10);
  });

  it('ret gerekçelerini append-only events tablosundan döndürür', async () => {
    const ports = createClickHouseBrakePorts(ch);
    const failures = await ports.readRecentFailures(taskId);
    expect(failures).toHaveLength(3);
    expect(failures[0]).toContain('null pointer');
  });

  // Regresyon: ret geçmişi başta tasks sürümlerinden okunuyordu; ClickHouse
  // ReplacingMergeTree birleştirmesi eski sürümleri sildiği için 3 satırdan
  // 1'i kalıyordu ve kaçak döngü freni sessizce ölü kalırdı.
  it('tasks sürüm geçmişi güvenilir bir hata kaynağı değildir', async () => {
    const result = await ch.query({
      query: 'SELECT count() AS n FROM tasks WHERE task_id = {taskId:UUID}',
      query_params: { taskId }, format: 'JSONEachRow',
    });
    const rows = await result.json<{ n: string | number }>();
    // Birleştirme zamanlamasına göre 1 veya 2 olabilir; kilit nokta: 3 değil.
    expect(Number(rows[0]!.n)).toBeLessThan(3);
  });

  it('bilinmeyen görev için güvenli varsayılan döner, patlamaz', async () => {
    const ports = createClickHouseBrakePorts(ch);
    const unknown = randomUUID();
    // Bilinmeyen görevde fren atmamalı: tavan 0 = sınırsız.
    await expect(ports.readTaskBudget(unknown)).resolves.toMatchObject({ tokenBudget: 0 });
    await expect(ports.readProjectSpend(unknown)).resolves.toMatchObject({ limitUsd: 0 });
    await expect(ports.readRecentFailures(unknown)).resolves.toEqual([]);
  });
});

describe.skipIf(!up)('gerçek portlarla uçtan uca fren', () => {
  const db = `ww_test_brake_e2e_${Date.now()}`;
  const projectId = randomUUID();
  const taskId = randomUUID();
  let ch: ClickHouseClient;

  beforeAll(async () => {
    await runMigrations({ database: db });
    ch = createCh({ database: db });
    const at = new Date().toISOString();
    // Bütçesi $5, harcaması $9 olan bir proje: maliyet freni atmalı.
    await ch.insert({ table: 'projects', values: [{
      project_id: projectId, name: 'asan', slug: 'asan', type: 'web', status: 'running',
      budget_usd_limit: 5, created_at: at, updated_at: at, version: 1,
    }], format: 'JSONEachRow' });
    await ch.insert({ table: 'tasks', values: [{
      task_id: taskId, project_id: projectId, title: 'pahalı', status: 'queued',
      issuer_agent_id: randomUUID(), token_budget: 0, tokens_spent: 0,
      created_at: at, updated_at: at, version: 1,
    }], format: 'JSONEachRow' });
    await ch.insert({ table: 'api_usage', values: [{
      usage_id: randomUUID(), project_id: projectId, task_id: taskId,
      provider_id: 'deepseek', model: 'deepseek-chat', purpose: 'completion',
      prompt_tokens: 1, completion_tokens: 1, cost_usd: 9, latency_ms: 1,
      status: 'ok', error_kind: '', created_at: at,
    }], format: 'JSONEachRow' });
  });

  afterAll(async () => {
    const admin = createCh({ database: 'default' });
    await admin.command({ query: `DROP DATABASE IF EXISTS ${db}` });
    await admin.close();
    await ch.close();
  });

  it('bütçesi aşılmış projede guard gerçekten cost_budget freni atar', async () => {
    const guard = createBrakeGuard(createClickHouseBrakePorts(ch));
    await expect(guard({ taskId, attempt: {} as never, attemptNumber: 1 }))
      .rejects.toMatchObject({ kind: 'cost_budget' });
  });
});
