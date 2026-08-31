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

  // ORG PLANI ARTIK SENTEZDEN OKUNUR. Eskiden proje ADINDAKİ kelimeye göre
  // ('tetris', 'pomodoro', 'hesap' ...) iki sabit şablondan biri seçiliyor,
  // konseyin nihai sentezi HİÇ okunmuyordu.
  it('departmanlari nihai sentezden okur', () => {
    const synthesis = {
      ...input.synthesis,
      text: [
        input.synthesis.text,
        '',
        '## DEPARTMANLAR',
        '### DEPARTMAN dept-api — Servis Katmani',
        'GRUP: coding',
        'DOSYALAR: src/api/**',
        'YAPAN: 2',
        'DENETLEYEN: 1',
        '',
        '### DEPARTMAN dept-ui — Arayuz',
        'GRUP: design',
        'DOSYALAR: src/views/**',
      ].join('\n'),
    };
    const plan = buildCouncilPlan({ ...input, synthesis: synthesis as never });
    const org = plan.team_json.org_plan;
    expect(org.departments.map((d) => d.id)).toEqual(['dept-api', 'dept-ui']);
    expect(org.departments[1]?.group).toBe('design');
    // Proje adı 'Tetris' bile olsa sonuç sentezden gelir.
    expect(buildCouncilPlan({ ...input, projectName: 'Tetris', synthesis: synthesis as never })
      .team_json.org_plan.departments).toHaveLength(2);
  });

  it('sentezde departman yoksa yedege duser ve bunu GORUNUR yazar', () => {
    const plan = buildCouncilPlan(input);
    expect(plan.team_json.org_plan.departments).toHaveLength(1);
    expect(plan.content_md).toContain('Organizasyon planı nihai sentezden okunamadı');
  });

  // Sabit 18000 token / $0.045 panelde gerçek tahmin gibi gösteriliyordu.
  it('uydurma butce tahmini yazmaz', () => {
    const org = buildCouncilPlan(input).team_json.org_plan;
    expect(org.estimated_tokens).toBe(0);
    expect(org.estimated_cost_usd).toBe(0);
  });

  // ÇEŞİTLİLİK UYARISI plana yazılmazsa, tek modelin kendini onayladığı bir
  // koşu gerçek konsey kararı gibi okunur.
  it('cesitlilik uyarisini planin govdesine yazar', () => {
    const plan = buildCouncilPlan({ ...input, diversityWarning: 'tek sağlayıcıya düşüldü' });
    expect(plan.content_md).toContain('tek sağlayıcıya düşüldü');
  });

  it('uyari yokken govdeye uyari eklemez', () => {
    const synthesis = {
      ...input.synthesis,
      text: `${input.synthesis.text}\n\n## DEPARTMANLAR\n### DEPARTMAN d1 — Uygulama\nGRUP: coding\nDOSYALAR: src/**\n`,
    };
    expect(buildCouncilPlan({ ...input, synthesis: synthesis as never }).content_md)
      .not.toContain('⚠️');
  });

  it('yeniden planlamada onceki plani devralir', () => {
    const previous = '00000000-0000-4000-8000-000000000009' as never;
    expect(buildCouncilPlan({ ...input, supersedesPlanId: previous, planVersion: 2 })
      .supersedes_plan_id).toBe(previous);
    expect(buildCouncilPlan(input).supersedes_plan_id).toBe(NIL_UUID);
  });
});
