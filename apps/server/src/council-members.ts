// Konsey üyelerinin seçimi (docs/03 → Konsey, docs/11 → Faz 4).
//
// NEDEN VAR: CouncilService yazılmış ve testliydi ama HİÇBİR üretim yolu onu
// çağırmıyordu — Faz 4'ün kalbi bağlanmamıştı. Bağlarken en kritik karar
// üyelerin hangi modellere düşeceğidir: konseyin amacı ÇAPRAZ KONTROLDÜR,
// yani aynı modelin kendi kendini onaylaması konseyi anlamsız kılar.
//
// Bu yüzden çeşitlilik sessizce düşürülmez: kaç ayrı sağlayıcıya düşüldüğü
// sonuçta RAPORLANIR ve çağıran bunu plana yazabilir.
import type { EntityId } from '@ww/shared';

export class CouncilMemberError extends Error {}

export interface AvailableAgent {
  readonly agentId: EntityId;
  readonly modelRef: string;
}

export interface CouncilComposition {
  readonly members: readonly { readonly agentId: EntityId; readonly modelRef: string }[];
  /** Kaç ayrı SAĞLAYICIYA düşüldü. 1 ise çapraz kontrol gerçek değildir. */
  readonly distinctProviders: number;
  /** Çeşitlilik hedefin altındaysa insanın göreceği açık uyarı. */
  readonly diversityWarning: string;
}

const MIN_MEMBERS = 3;
const MAX_MEMBERS = 4;

const providerOf = (modelRef: string): string => modelRef.split(':')[0] ?? '';

/**
 * Üyeler önce SAĞLAYICI çeşitliliğine, sonra model çeşitliliğine göre seçilir:
 * her sağlayıcıdan birer üye alınır, kota dolmazsa aynı sağlayıcının farklı
 * modelleriyle tamamlanır, o da yetmezse kalanlarla.
 */
export interface CouncilCompositionOptions {
  /**
   * Ağ çağrısı yapmayan (base_url'ü boş) taklit sağlayıcılar. Üyeleri
   * konseye ALINMAZ: taklidin "itirazı" senaryodan gelir ve konseyin çapraz
   * kontrol yaptığı yalanını söyler. İlk canlı koşuda üyelerden biri
   * `mock:pm` çıktı ve konsey 2 sağlayıcılı görünüyordu.
   */
  readonly stubProviders?: readonly string[];
}

export function composeCouncil(
  available: readonly AvailableAgent[],
  options: CouncilCompositionOptions = {},
): CouncilComposition {
  const stubs = new Set(options.stubProviders ?? []);
  const usable = available.filter((agent) =>
    agent.modelRef.includes(':') && !stubs.has(providerOf(agent.modelRef)));
  if (usable.length < MIN_MEMBERS) {
    throw new CouncilMemberError(
      `konsey icin en az ${MIN_MEMBERS} uye gerekir, ${usable.length} var`,
    );
  }

  const chosen: AvailableAgent[] = [];
  const seenProviders = new Set<string>();
  const seenModels = new Set<string>();

  for (const agent of usable) {
    if (chosen.length >= MAX_MEMBERS) break;
    const provider = providerOf(agent.modelRef);
    if (seenProviders.has(provider)) continue;
    seenProviders.add(provider);
    seenModels.add(agent.modelRef);
    chosen.push(agent);
  }
  for (const agent of usable) {
    if (chosen.length >= MAX_MEMBERS) break;
    if (chosen.includes(agent) || seenModels.has(agent.modelRef)) continue;
    seenModels.add(agent.modelRef);
    chosen.push(agent);
  }
  for (const agent of usable) {
    if (chosen.length >= MIN_MEMBERS) break;
    if (chosen.includes(agent)) continue;
    chosen.push(agent);
  }

  const distinctProviders = new Set(chosen.map((agent) => providerOf(agent.modelRef))).size;
  const diversityWarning = distinctProviders >= MIN_MEMBERS
    ? ''
    : `konsey ${distinctProviders} sağlayıcıya düştü (hedef ${MIN_MEMBERS}): `
      + 'çapraz kontrol bu koşuda tam değildir';

  return Object.freeze({
    members: Object.freeze(chosen.map((agent) => Object.freeze({
      agentId: agent.agentId, modelRef: agent.modelRef,
    }))),
    distinctProviders,
    diversityWarning,
  });
}
