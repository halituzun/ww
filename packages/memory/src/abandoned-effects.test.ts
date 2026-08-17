import { describe, expect, it } from 'vitest';
import { planEffectReconciliation } from './abandoned-effects.js';

const effect = (over: Partial<Parameters<typeof planEffectReconciliation>[0][number]> = {}) => ({
  causation_id: 'c1', stable_effect_id: 's1', state: 'pending', replay_safety: 'replay_safe',
  ...over,
});

describe('planEffectReconciliation', () => {
  // ASIL KUSUR: yarıda kalan atama etkisi `pending` kalıyor ve görev kalıcı
  // olarak atanamaz hale geliyordu.
  it('replay-safe pending etkiyi terk edilebilir sayar', () => {
    const plan = planEffectReconciliation([effect()]);
    expect(plan.abandon).toHaveLength(1);
    expect(plan.escalate).toHaveLength(0);
  });

  it('replay-safe uncertain etkiyi de terk edilebilir sayar', () => {
    expect(planEffectReconciliation([effect({ state: 'uncertain' })]).abandon).toHaveLength(1);
  });

  // Tekrarı güvenli OLMAYAN etkiyi otomatik kapatmak, yan etkiyi iki kez
  // uygulama riskidir: bu sınıf her zaman tırmandırılır.
  it('non-replay-safe etkiyi otomatik kapatmaz, tirmandirir', () => {
    const plan = planEffectReconciliation([effect({ replay_safety: 'non_replay_safe' })]);
    expect(plan.abandon).toHaveLength(0);
    expect(plan.escalate).toHaveLength(1);
  });

  // Bitmiş etkiye dokunmak, tamamlanmış işi geri alır.
  it('terminal etkilere dokunmaz', () => {
    const plan = planEffectReconciliation([
      effect({ state: 'succeeded' }), effect({ state: 'failed' }),
    ]);
    expect(plan.abandon).toHaveLength(0);
    expect(plan.escalate).toHaveLength(0);
  });

  it('bilinmeyen replay-safety degerini guvenli tarafa koyar', () => {
    expect(planEffectReconciliation([effect({ replay_safety: 'bilinmiyor' })]).escalate)
      .toHaveLength(1);
  });

  it('bos girdide bos plan doner', () => {
    expect(planEffectReconciliation([])).toEqual({ abandon: [], escalate: [] });
  });
});
