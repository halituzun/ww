import { describe, expect, it, vi } from 'vitest';
import { PlanApprovalError, PlanApprovalService } from './plan-approval-service.js';
import type { EntityId } from '@ww/shared';

const PROJECT = '11111111-1111-4111-8111-111111111111' as EntityId;
const PLAN = '22222222-2222-4222-8222-222222222222' as EntityId;
const AGENT = '33333333-3333-4333-8333-333333333333' as EntityId;

const planRow = (over: Record<string, unknown> = {}) => ({
  plan_id: PLAN,
  project_id: PROJECT,
  plan_version: 1,
  status: 'proposed',
  title: 'plan',
  content_md: '# plan',
  council_session_id: '00000000-0000-0000-0000-000000000000',
  // ClickHouse JSON kolonlarını STRING döndürür; fixture bunu taklit
  // etmezse test gerçek okuma yolunu hiç denemez.
  team_json: '{}',
  scenarios_json: JSON.stringify({ version: 1, tasks: [] }),
  replan_reason: '',
  supersedes_plan_id: '00000000-0000-0000-0000-000000000000',
  created_by_agent_id: AGENT,
  approved_by: '',
  created_at: '2026-01-01T00:00:00.000Z',
  observed_at: '2026-01-01T00:00:00.000Z',
  version: '1',
  ...over,
});

/**
 * Sahte ClickHouse — DURUMLU.
 *
 * NEDEN durumlu: eski test her sorgu için AYNI boş diziyi döndüren tek
 * satırlık bir sahte kullanıyordu; hangi sorgunun sorulduğunu hiç
 * doğrulamadan "plan bulunamadi" yolunu geçiriyordu. Gerçek yazma yolu
 * (appendPlanVersion) yazdıktan SONRA yeni sürümü geri okur ve içerik
 * karşılaştırır; durumsuz bir sahte bu yolu hiç denemez.
 */
function fakeCh(options: {
  plans?: Record<string, unknown>[];
  agents?: unknown[];
  tasks?: unknown[];
  onInsert?: (table: string, values: readonly unknown[]) => void;
}) {
  const plans = [...(options.plans ?? [])];

  const rows = (query: string, params: Record<string, unknown> | undefined): unknown[] => {
    if (query.includes('FROM plans')) {
      const version = params?.['version'];
      return version === undefined
        ? plans
        : plans.filter((row) => String(row['version']) === String(version));
    }
    if (query.includes('FROM agents')) return options.agents ?? [];
    if (query.includes('FROM tasks')) return options.tasks ?? [];
    return [];
  };

  return {
    query: async ({ query, query_params }: { query: string; query_params?: Record<string, unknown> }) =>
      ({ json: async () => rows(query, query_params) }),
    insert: async ({ table, values }: { table?: string; values?: readonly unknown[] }) => {
      if (!values) return;
      if (table === 'plans') plans.push(...(values as Record<string, unknown>[]));
      options.onInsert?.(table ?? '', values);
    },
    command: async () => undefined,
  } as never;
}

const service = (ch: never, enqueue = vi.fn(async () => undefined)) => ({
  enqueue,
  instance: new PlanApprovalService(ch, { enqueue: enqueue as never }, {
    newTaskId: (() => {
      let n = 0;
      return () => `44444444-4444-4444-8444-${String(++n).padStart(12, '0')}` as EntityId;
    })(),
  }),
});

const input = (approved = true) => ({
  projectId: PROJECT,
  planId: PLAN,
  approved,
  actor: 'user',
  now: '2026-01-01T00:00:00.000Z',
});

describe('PlanApprovalService', () => {
  it('plan bulunamazsa fail-closed düşer', async () => {
    const { instance } = service(fakeCh({}));
    await expect(instance.apply(input())).rejects.toThrow('plan bulunamadi');
  });

  // Bu, düzeltilen kusurun mühürüdür: onay bir DURUM DEĞİŞİKLİĞİ değil,
  // görev üreten bir İŞLEMDİR. Görev kırılımı yoksa onay reddedilmeli;
  // yoksa panel "Görevler yürütmeye alındı" derken kuyruk boş kalır.
  it('görev kırılımı taşımayan planı onaylamayı reddeder', async () => {
    const { instance, enqueue } = service(fakeCh({ plans: [planRow()] }));
    await expect(instance.apply(input())).rejects.toThrow(PlanApprovalError);
    await expect(instance.apply(input())).rejects.toThrow(/gorev kirilimi tasimiyor/);
    expect(enqueue).not.toHaveBeenCalled();
  });

  // NOT: onayın görev AÇMA yolu gerçek ClickHouse ister (plan yazımı
  // `INSERT ... SELECT` ile sunucu tarafında observed_at üretir); sahteyle
  // taklit etmek ClickHouse'u yeniden yazmak olurdu. O yol
  // plan-activation.integration.test.ts içinde doğrulanır.
});
