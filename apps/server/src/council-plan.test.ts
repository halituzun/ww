import { describe, expect, it } from 'vitest';
import { NIL_UUID } from '@ww/shared';
import { buildCouncilPlan } from './council-plan.js';

const turn = (memberId: string, kind: string, text: string) => ({ memberId, kind, text });

const input = {
  projectId: '00000000-0000-4000-8000-000000000001' as never,
  projectName: 'Yapılacaklar',
  planId: '00000000-0000-4000-8000-000000000002' as never,
  planVersion: 1,
  sessionId: '00000000-0000-4000-8000-000000000003' as never,
  chairAgentId: '00000000-0000-4000-8000-000000000004' as never,
  goal: 'Basit bir yapılacaklar listesi',
  proposals: [turn('aaaaaaaa-1111-4111-8111-111111111111', 'proposal', 'React ile başla')],
  objections: [turn('bbbbbbbb-2222-4222-8222-222222222222', 'objection', 'Durum yönetimi eksik')],
  synthesis: turn('cccccccc-3333-4333-8333-333333333333', 'synthesis', 'React + basit store'),
  memberModelRefs: ['deepseek:deepseek-chat', 'openai:gpt-5', 'anthropic:claude-sonnet-5'],
  diversityWarning: '',
  createdAt: '2026-08-18T09:00:00.000Z',
};

describe('buildCouncilPlan', () => {
  // Otomatik onaylamak, olmayan bir kullanıcı onayını varmış gibi gösterirdi.
  it('plani onaylanmis degil ONERILMIS yazar', () => {
    const plan = buildCouncilPlan(input);
    expect(plan.status).toBe('proposed');
    expect(plan.approved_by).toBe('');
  });

  // "Bu karar nasıl alındı" zinciri: plan → council_session_id → messages.
  it('plani konsey oturumuna baglar', () => {
    expect(buildCouncilPlan(input).council_session_id).toBe(input.sessionId);
  });

  it('sentezi karar bolumune yazar', () => {
    expect(buildCouncilPlan(input).content_md).toContain('React + basit store');
  });

  // İtirazlar kaybolursa "neden bu karar" sorusunun yarısı silinir.
  it('oneri ve itirazlari da saklar', () => {
    const body = buildCouncilPlan(input).content_md;
    expect(body).toContain('React ile başla');
    expect(body).toContain('Durum yönetimi eksik');
  });

  it('uye modellerini ve org_plan yapisini plana yazar', () => {
    const plan = buildCouncilPlan(input);
    expect(plan.content_md).toContain('deepseek:deepseek-chat');
    expect(plan.team_json).toMatchObject({
      members: input.memberModelRefs,
      org_plan: expect.objectContaining({
        departments: expect.any(Array),
        concurrency_limit: expect.any(Number),
      }),
    });
  });

  it('deriveOrgPlan kucuk projede (Tetris, Pomodoro) 2 departman onerir', () => {
    const org = buildCouncilPlan({ ...input, projectName: 'Tetris' }).team_json.org_plan;
    expect(org.departments).toHaveLength(2);
    expect(org.concurrency_limit).toBe(2);
  });

  it('deriveOrgPlan buyuk projede 4 departman onerir', () => {
    const org = buildCouncilPlan({ ...input, projectName: 'E-Ticaret Paneli' }).team_json.org_plan;
    expect(org.departments).toHaveLength(4);
    expect(org.concurrency_limit).toBe(3);
  });

  // ÇEŞİTLİLİK UYARISI plana yazılmazsa, tek modelin kendini onayladığı bir
  // koşu gerçek konsey kararı gibi okunur.
  it('cesitlilik uyarisini planin govdesine yazar', () => {
    const plan = buildCouncilPlan({ ...input, diversityWarning: 'tek sağlayıcıya düşüldü' });
    expect(plan.content_md).toContain('tek sağlayıcıya düşüldü');
  });

  it('uyari yokken govdeye uyari eklemez', () => {
    expect(buildCouncilPlan(input).content_md).not.toContain('⚠️');
  });

  it('yeniden planlamada onceki plani devralir', () => {
    const previous = '00000000-0000-4000-8000-000000000009' as never;
    expect(buildCouncilPlan({ ...input, supersedesPlanId: previous, planVersion: 2 })
      .supersedes_plan_id).toBe(previous);
    expect(buildCouncilPlan(input).supersedes_plan_id).toBe(NIL_UUID);
  });
});
