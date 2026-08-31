import { describe, expect, it } from 'vitest';
import { NIL_UUID } from '@ww/shared';
import { buildBootstrapPlan } from './bootstrap-plan.js';

const input = {
  projectId: '00000000-0000-4000-8000-000000000001' as never,
  projectName: 'Satranç',
  planId: '00000000-0000-4000-8000-000000000002' as never,
  createdByAgentId: '00000000-0000-4000-8000-000000000003' as never,
  createdAt: '2026-08-17T20:00:00.000Z',
};

describe('buildBootstrapPlan', () => {
  // ASIL KUSUR: plansız projede her görev "task plan kimligi tasimiyor" ile
  // reddediliyor, kullanıcıya "queued" görünürken hiç çalışmıyordu.
  it('gorevlerin baglanabilecegi onayli bir plan uretir', () => {
    const plan = buildBootstrapPlan(input);
    expect(plan.status).toBe('approved');
    expect(plan.plan_id).toBe(input.planId);
    expect(plan.project_id).toBe(input.projectId);
  });

  it('plani projeye ve olusturan agent’a baglar', () => {
    const plan = buildBootstrapPlan(input);
    expect(plan.created_by_agent_id).toBe(input.createdByAgentId);
    expect(plan.created_at).toBe(input.createdAt);
  });

  // Konsey çıktısı gibi görünmemeli: sahte köken, "bu plan nasıl oluştu"
  // sorusunun cevabını bozar.
  it('konsey oturumu uydurmaz', () => {
    const plan = buildBootstrapPlan(input);
    expect(plan.council_session_id).toBe(NIL_UUID);
    expect(plan.supersedes_plan_id).toBe(NIL_UUID);
    expect(plan.approved_by).toBe('bootstrap');
  });

  it('temel plan oldugunu acikca yazar', () => {
    const plan = buildBootstrapPlan(input);
    expect(plan.title).toContain('temel plan');
    expect(plan.content_md).toContain('temel plandır');
  });

  it('proje adini basliga tasir', () => {
    expect(buildBootstrapPlan({ ...input, projectName: 'Kasa' }).title).toContain('Kasa');
  });
});
