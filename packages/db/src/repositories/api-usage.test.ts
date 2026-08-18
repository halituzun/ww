import { randomUUID } from 'node:crypto';
import type { ClickHouseClient } from '@clickhouse/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCh } from '../client.js';
import { runMigrations } from '../migrate.js';
import { clickhouseUp } from '../testutil.js';
import { getActualModelRefForInvocation, sumTaskTokensSpent } from './api-usage.js';
import { RepositoryConflictError } from './types.js';

const up = await clickhouseUp();

describe.skipIf(!up)('api usage repository', () => {
  const db = `ww_test_api_usage_${Date.now()}_${process.pid}`;
  let ch: ClickHouseClient;

  beforeAll(async () => {
    await runMigrations({ database: db });
    ch = createCh({ database: db });
  });

  afterAll(async () => {
    const admin = createCh({ database: 'default' });
    await admin.command({ query: `DROP DATABASE IF EXISTS ${db}` });
    await admin.close();
    await ch.close();
  });

  function scope() {
    return {
      projectId: randomUUID(),
      agentId: randomUUID(),
      taskId: randomUUID(),
      taskBriefId: randomUUID(),
      assignmentAttemptId: randomUUID(),
      promptInputSnapshotId: randomUUID(),
    };
  }

  function usage(
    invocationId: string,
    expected: ReturnType<typeof scope>,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      usage_id: randomUUID(),
      project_id: expected.projectId,
      agent_id: expected.agentId,
      task_id: expected.taskId,
      provider_id: 'openai',
      model: 'gpt-primary',
      purpose: 'completion',
      prompt_tokens: 10,
      completion_tokens: 5,
      cost_usd: 0.1,
      latency_ms: 20,
      status: 'ok',
      error_kind: '',
      invocation_id: invocationId,
      task_brief_id: expected.taskBriefId,
      assignment_attempt_id: expected.assignmentAttemptId,
      prompt_input_snapshot_id: expected.promptInputSnapshotId,
      fallback_attempt: 0,
      created_at: '2026-08-14T12:00:00.000Z',
      ...overrides,
    };
  }

  it('highest successful fallback attempt gercek modeli ve exact scopeu dondurur', async () => {
    const invocationId = randomUUID();
    const expected = scope();
    const duplicateUsageId = randomUUID();
    await ch.insert({
      table: 'api_usage',
      values: [
        usage(invocationId, expected, {
          provider_id: 'openai',
          model: 'gpt-primary',
          status: 'error',
          error_kind: 'timeout',
          fallback_attempt: 0,
        }),
        usage(invocationId, expected, {
          usage_id: duplicateUsageId,
          provider_id: 'anthropic',
          model: 'claude-fallback',
          status: 'fallback_used',
          fallback_attempt: 1,
        }),
        usage(invocationId, expected, {
          provider_id: 'anthropic',
          model: 'claude-fallback',
          status: 'fallback_used',
          fallback_attempt: 1,
        }),
      ],
      format: 'JSONEachRow',
    });

    const actual = await getActualModelRefForInvocation(ch, invocationId, expected);
    expect(actual).toMatchObject({
      invocationId,
      usedRef: 'anthropic:claude-fallback',
      fallbackAttempt: 1,
      ...expected,
    });
    expect(actual?.usageIds).toContain(duplicateUsageId);
  });

  it('successful model veya provenance belirsizligini fail-closed reddeder', async () => {
    const invocationId = randomUUID();
    const expected = scope();
    await ch.insert({
      table: 'api_usage',
      values: [
        usage(invocationId, expected, { fallback_attempt: 2, status: 'fallback_used' }),
        usage(invocationId, expected, {
          provider_id: 'other',
          model: 'different',
          fallback_attempt: 2,
          status: 'fallback_used',
        }),
      ],
      format: 'JSONEachRow',
    });
    await expect(getActualModelRefForInvocation(ch, invocationId, expected))
      .rejects.toBeInstanceOf(RepositoryConflictError);
  });

  it('expected invocation scope uyusmazligini reddeder ve basarisiz cagriyi model saymaz', async () => {
    const failedInvocationId = randomUUID();
    const expected = scope();
    await ch.insert({
      table: 'api_usage',
      values: [usage(failedInvocationId, expected, { status: 'error' })],
      format: 'JSONEachRow',
    });
    expect(await getActualModelRefForInvocation(ch, failedInvocationId, expected)).toBeNull();

    const successfulInvocationId = randomUUID();
    await ch.insert({
      table: 'api_usage',
      values: [usage(successfulInvocationId, expected)],
      format: 'JSONEachRow',
    });
    await expect(getActualModelRefForInvocation(ch, successfulInvocationId, {
      ...expected,
      taskId: randomUUID(),
    })).rejects.toBeInstanceOf(RepositoryConflictError);
  });

  it('successful embedding veya health check kaydini actual model completion saymaz', async () => {
    const expected = scope();
    for (const purpose of ['embedding', 'health_check']) {
      const invocationId = randomUUID();
      await ch.insert({
        table: 'api_usage',
        values: [usage(invocationId, expected, { purpose })],
        format: 'JSONEachRow',
      });
      await expect(getActualModelRefForInvocation(ch, invocationId, expected))
        .rejects.toBeInstanceOf(RepositoryConflictError);
    }
  });

  it('completion ile ayni invocation altindaki farkli purposeu fail-closed reddeder', async () => {
    const invocationId = randomUUID();
    const expected = scope();
    await ch.insert({
      table: 'api_usage',
      values: [
        usage(invocationId, expected),
        usage(invocationId, expected, {
          purpose: 'embedding',
          model: 'text-embedding-3-small',
        }),
      ],
      format: 'JSONEachRow',
    });

    await expect(getActualModelRefForInvocation(ch, invocationId, expected))
      .rejects.toBeInstanceOf(RepositoryConflictError);
  });

  it('invocation aday cevabini bounded tutar ve asiri exact duplicatei fail-closed reddeder', async () => {
    const invocationId = randomUUID();
    const expected = scope();
    await ch.insert({
      table: 'api_usage',
      values: Array.from({ length: 101 }, () => usage(invocationId, expected)),
      format: 'JSONEachRow',
    });
    await expect(getActualModelRefForInvocation(ch, invocationId, expected))
      .rejects.toBeInstanceOf(RepositoryConflictError);
  });

  it('invocation indexi 50k multi-granule veride exact primary-key pruning yapar', async () => {
    const expected = scope();
    const targetInvocationId = '88888888-8888-4888-8888-888888888888';
    const rows = Array.from({ length: 50_001 }, (_, index) => usage(
      index === 25_000 ? targetInvocationId : randomUUID(),
      expected,
    ));
    await ch.insert({ table: 'api_usage', values: rows, format: 'JSONEachRow' });
    expect(await getActualModelRefForInvocation(ch, targetInvocationId, expected))
      .toMatchObject({ invocationId: targetInvocationId, usedRef: 'openai:gpt-primary' });

    const explanation = await ch.query({
      query: `EXPLAIN indexes = 1
        SELECT usage_id FROM invocation_api_usage
        PREWHERE invocation_id = {invocationId:UUID}
        LIMIT 101`,
      query_params: { invocationId: targetInvocationId },
      format: 'JSONEachRow',
    });
    const explainText = (await explanation.json<{ explain: string }>())
      .map((row) => row.explain)
      .join('\n');
    const granules = [...explainText.matchAll(/Granules: (\d+)\/(\d+)/g)]
      .map((match) => ({ selected: Number(match[1]), total: Number(match[2]) }));
    expect(granules.some(({ selected, total }) => total >= 6 && selected < total)).toBe(true);
  }, 30_000);

  // docs/04 pasif sinyal: "mv_provider_errors — son 5 dk hata oranı > %50 →
  // degraded". İki kusur ölçüldü ve bu test ikisini de sabitliyor.
  // docs/07 "görev token tavanı" freninin GERÇEK girdisi. Fren daha önce
  // `tasks.tokens_spent` kolonunu okuyordu ve o kolona üretimde 0'dan başka
  // bir şey yazılmıyor — yani fren yazılı, testli ve kalıcı olarak ölüydü.
  describe('sumTaskTokensSpent', () => {
    it('gorevin prompt + completion tokenlarini toplar', async () => {
      const taskId = randomUUID();
      const projectId = randomUUID();
      const at = new Date().toISOString();
      await ch.insert({
        table: 'api_usage',
        values: [
          { usage_id: randomUUID(), project_id: projectId, task_id: taskId, provider_id: 'deepseek', model: 'm', purpose: 'completion', prompt_tokens: 100, completion_tokens: 50, cost_usd: 0.1, latency_ms: 1, status: 'ok', error_kind: '', created_at: at },
          // Başarısız çağrı da sayılır: token yakıldıysa yakılmıştır.
          { usage_id: randomUUID(), project_id: projectId, task_id: taskId, provider_id: 'deepseek', model: 'm', purpose: 'completion', prompt_tokens: 20, completion_tokens: 0, cost_usd: 0, latency_ms: 1, status: 'error', error_kind: 'rate_limit', created_at: at },
          // BAŞKA görevin çağrısı sayılmaz.
          { usage_id: randomUUID(), project_id: projectId, task_id: randomUUID(), provider_id: 'deepseek', model: 'm', purpose: 'completion', prompt_tokens: 999, completion_tokens: 999, cost_usd: 0, latency_ms: 1, status: 'ok', error_kind: '', created_at: at },
        ],
        format: 'JSONEachRow',
      });
      expect(await sumTaskTokensSpent(ch, taskId)).toBe(170);
    });

    // Hiç çağrısı olmayan görevde fren ATMAMALI: 0 döner, sistem durmaz.
    it('cagrisi olmayan gorev icin 0 doner', async () => {
      expect(await sumTaskTokensSpent(ch, randomUUID())).toBe(0);
    });
  });

  describe('mv_provider_errors sinyali', () => {
    const insertUsage = async (rows: readonly Record<string, unknown>[]) => {
      await ch.insert({
        table: 'api_usage',
        values: rows.map((row) => ({
          usage_id: randomUUID(), project_id: randomUUID(), agent_id: randomUUID(),
          task_id: randomUUID(), model: 'm', prompt_tokens: 1, completion_tokens: 1,
          cost_usd: 0.001, latency_ms: 5, error_kind: '',
          created_at: new Date().toISOString(), ...row,
        })),
        format: 'JSONEachRow',
      });
    };
    const rate = async (providerId: string) => {
      const rows = await ch.query({
        query: `SELECT sum(errors) AS errors, sum(total) AS total FROM mv_provider_errors
          WHERE provider_id = {providerId:String}`,
        query_params: { providerId }, format: 'JSONEachRow',
      }).then((r) => r.json<{ errors: string; total: string }>());
      return { errors: Number(rows[0]?.errors ?? 0), total: Number(rows[0]?.total ?? 0) };
    };

    // `fallback_used` BAŞARILI bir çağrıdır: yedek sağlayıcı isteği
    // karşılamıştır (canlı veride token ve maliyet taşıyor). Onu hata saymak,
    // fallback'i tam da işe yaradığı anda "bozuk" göstermekti.
    it('fallback_usedi hata saymaz', async () => {
      const providerId = `p_${randomUUID().slice(0, 8)}`;
      await insertUsage([
        { provider_id: providerId, purpose: 'completion', status: 'fallback_used' },
        { provider_id: providerId, purpose: 'completion', status: 'ok' },
      ]);
      expect(await rate(providerId)).toEqual({ errors: 0, total: 2 });
    });

    // docs/04 iki BAĞIMSIZ sinyal tanımlar: aktif ping ve pasif hata oranı.
    // Ping'leri pasif sinyale katmak ikisini tek sinyale indirger — gerçek
    // trafiği olmayan sağlayıcı yalnız ping'leri yüzünden %100 hata
    // gösteriyordu.
    it('saglik pinglerini pasif sinyale katmaz', async () => {
      const providerId = `p_${randomUUID().slice(0, 8)}`;
      await insertUsage([
        { provider_id: providerId, purpose: 'health_check', status: 'error' },
        { provider_id: providerId, purpose: 'health_check', status: 'ok' },
        { provider_id: providerId, purpose: 'completion', status: 'ok' },
      ]);
      expect(await rate(providerId)).toEqual({ errors: 0, total: 1 });
    });

    it('gercek hatalari sayar', async () => {
      const providerId = `p_${randomUUID().slice(0, 8)}`;
      await insertUsage([
        { provider_id: providerId, purpose: 'completion', status: 'error' },
        { provider_id: providerId, purpose: 'completion', status: 'timeout' },
        { provider_id: providerId, purpose: 'completion', status: 'rate_limited' },
        { provider_id: providerId, purpose: 'completion', status: 'ok' },
      ]);
      expect(await rate(providerId)).toEqual({ errors: 3, total: 4 });
    });
  });
});
