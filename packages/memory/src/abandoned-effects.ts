// Terk edilmiş etkilerin uzlaştırılması.
//
// NEDEN VAR: süreç atama sırasında ölünce, atama komutunun etki kaydı
// `pending` durumunda kalıyor. Görev kurtarmayla kuyruğa geri alınsa bile
// yeni atama şununla reddediliyor:
//   SchedulerError: task icin baska assignment command uzlastirilmamis: <id>
// Yani görev KALICI olarak atanamaz hale geliyor — canlı koşuda tam olarak
// buna takıldım. Kurtarma görevi geri alıyor ama yarıda bıraktığı etkiyi
// uzlaştırmıyordu.
//
// KRİTİK AYRIM: yalnızca `replay_safe` etkiler otomatik kapatılabilir; tekrarı
// güvenli olmayan etki belirsiz durumdayken otomatik çözülemez, TIRMANDIRILIR.
// Bu ayrım deponun dayanıklılık sözleşmesinin çekirdeğidir.

export interface AbandonableEffect {
  readonly causation_id: string;
  readonly stable_effect_id: string;
  readonly state: string;
  readonly replay_safety: string;
}

export interface ReconciliationPlan {
  /** Güvenle 'failed' yazılıp yeni denemeye yol açılabilecek etkiler. */
  readonly abandon: readonly AbandonableEffect[];
  /** Otomatik çözülemez; insan/tırmandırma gerektirir. */
  readonly escalate: readonly AbandonableEffect[];
}

const NON_TERMINAL: ReadonlySet<string> = new Set(['pending', 'uncertain']);

export function planEffectReconciliation(
  effects: readonly AbandonableEffect[],
): ReconciliationPlan {
  const abandon: AbandonableEffect[] = [];
  const escalate: AbandonableEffect[] = [];
  for (const effect of effects) {
    if (!NON_TERMINAL.has(effect.state)) continue;
    if (effect.replay_safety === 'replay_safe') abandon.push(effect);
    else escalate.push(effect);
  }
  return { abandon, escalate };
}
