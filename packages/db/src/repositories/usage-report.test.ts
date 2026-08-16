import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCh, type ClickHouseClient } from '../client.js';
import { runMigrations } from '../migrate.js';
import { clickhouseUp } from '../testutil.js';
import { budgetStatus, readUsageReport } from './usage-report.js';

const up = await clickhouseUp();

describe.skipIf(!up)('usage report', () => {
  const db = `ww_test_usage_${Date.now()}`;
  const projectId = randomUUID();
  const otherProject = randomUUID();
  const taskA = randomUUID();
  const taskB = randomUUID();
  let ch: ClickHouseClient;

  beforeAll(async () => {
    await runMigrations({ database: db });
    ch = createCh({ database: db });
    const at = (daysAgo: number) =>
      new Date(Date.now() - daysAgo * 86_400_000).toISOString();

    await ch.insert({
      table: 'api_usage',
      values: [
        { usage_id: randomUUID(), project_id: projectId, task_id: taskA, provider_id: 'deepseek', model: 'deepseek-chat', purpose: 'completion', prompt_tokens: 1000, completion_tokens: 500, cost_usd: 2, latency_ms: 100, status: 'ok', error_kind: '', created_at: at(0) },
        { usage_id: randomUUID(), project_id: projectId, task_id: taskA, provider_id: 'deepseek', model: 'deepseek-chat', purpose: 'completion', prompt_tokens: 500, completion_tokens: 200, cost_usd: 1, latency_ms: 90, status: 'ok', error_kind: '', created_at: at(1) },
        { usage_id: randomUUID(), project_id: projectId, task_id: taskB, provider_id: 'openai', model: 'gpt-5-mini', purpose: 'completion', prompt_tokens: 200, completion_tokens: 100, cost_usd: 0.5, latency_ms: 80, status: 'error', error_kind: 'timeout', created_at: at(1) },
        // Başka projenin harcaması rapora sızmamalı.
        { usage_id: randomUUID(), project_id: otherProject, task_id: randomUUID(), provider_id: 'deepseek', model: 'deepseek-chat', purpose: 'completion', prompt_tokens: 9999, completion_tokens: 9999, cost_usd: 99, latency_ms: 10, status: 'ok', error_kind: '', created_at: at(0) },
      ],
      format: 'JSONEachRow',
    });
  });

  afterAll(async () => {
    const admin = createCh({ database: 'default' });
    await admin.command({ query: `DROP DATABASE IF EXISTS ${db}` });
    await admin.close();
    await ch.close();
  });

  it('toplamları yalnız istenen projeden hesaplar', async () => {
    const report = await readUsageReport(ch, projectId);
    expect(report.totals.costUsd).toBeCloseTo(3.5, 6);
    expect(report.totals.calls).toBe(3);
    expect(report.totals.promptTokens).toBe(1700);
  });

  it('günlük seriyi tarih sırasıyla döner', async () => {
    const report = await readUsageReport(ch, projectId);
    expect(report.daily.length).toBeGreaterThanOrEqual(2);
    const days = report.daily.map((point) => point.day);
    expect([...days].sort()).toEqual(days);
    expect(report.daily.reduce((sum, point) => sum + point.costUsd, 0)).toBeCloseTo(3.5, 6);
  });

  it('sağlayıcı/model kırılımını maliyete göre azalan sıralar', async () => {
    const report = await readUsageReport(ch, projectId);
    expect(report.byModel[0]).toMatchObject({ providerId: 'deepseek', model: 'deepseek-chat' });
    expect(report.byModel[0]!.costUsd).toBeCloseTo(3, 6);
    expect(report.byModel.at(-1)!.providerId).toBe('openai');
  });

  it('en pahalı görevleri sıralar', async () => {
    const report = await readUsageReport(ch, projectId);
    expect(report.topTasks[0]).toMatchObject({ taskId: taskA });
    expect(report.topTasks[0]!.costUsd).toBeCloseTo(3, 6);
  });

  it('hata oranını raporlar', async () => {
    const report = await readUsageReport(ch, projectId);
    expect(report.totals.errors).toBe(1);
  });

  it('harcaması olmayan proje için boş rapor döner', async () => {
    const report = await readUsageReport(ch, randomUUID());
    expect(report.totals.costUsd).toBe(0);
    expect(report.daily).toEqual([]);
    expect(report.topTasks).toEqual([]);
  });
});

describe('budgetStatus', () => {
  it('limit yoksa sınırsız sayar', () => {
    expect(budgetStatus(50, 0)).toMatchObject({ state: 'unlimited', ratio: 0 });
  });

  it('%80 altında ok', () => {
    expect(budgetStatus(7, 10)).toMatchObject({ state: 'ok' });
  });

  // docs/04: tavanın %80'inde panel bildirimi.
  it('%80 ve üstünde uyarı verir', () => {
    expect(budgetStatus(8, 10).state).toBe('warning');
    expect(budgetStatus(9.99, 10).state).toBe('warning');
  });

  it('limite ulaşınca aşıldı sayar', () => {
    expect(budgetStatus(10, 10).state).toBe('exceeded');
    expect(budgetStatus(12, 10).state).toBe('exceeded');
  });

  it('oranı hesaplar', () => {
    expect(budgetStatus(5, 10).ratio).toBeCloseTo(0.5, 6);
  });

  it('geçersiz girdiyi reddeder', () => {
    expect(() => budgetStatus(-1, 10)).toThrow(/harcama/i);
    expect(() => budgetStatus(1, -10)).toThrow(/limit/i);
  });
});
