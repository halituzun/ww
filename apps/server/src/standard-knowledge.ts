// Projenin kod standartlarını `knowledge`'a tohumlar (docs/06 Context Builder
// sabit çekirdeği: "brief'te sürüm/hash ile sabitlenmiş kod standartları
// (kind='standard')").
//
// NEDEN VAR: canlı veride ÖLÇÜLDÜ (2026-08-18) — 78 proje, `knowledge`
// tablosunda kind='standard' olan SIFIR satır. Yani hiçbir worker prompt'u
// kod standartlarını içermiyordu. Sonra aynı sistem docs/09 denetçisini
// koşturup tam da o standartlardan bulgu açıyor ve düzeltme görevi
// veriyordu: worker'a hiç söylenmemiş bir kuraldan ceza. Bulgu üretmek
// kolaydır; kuralı ÖNCEDEN söylemek işin doğru yapılmasını sağlar.
//
// Metinler denetçinin kural kimliklerinden türer ve bir test her kuralın
// karşılığının burada bulunduğunu doğrular: denetçi yeni bir kural
// kazandığında prompt sessizce eskimez.
import { canonicalSha256V1, EntityIdSchema, NIL_UUID, type EntityId } from '@ww/shared';
import type { StandardRuleId } from './standards-audit.js';

export interface StandardKnowledgeEntry {
  readonly ruleId: StandardRuleId;
  readonly title: string;
  readonly content: string;
}

export const STANDARD_KNOWLEDGE: readonly StandardKnowledgeEntry[] = Object.freeze([
  Object.freeze({
    ruleId: 'STD-001' as const,
    title: 'MVVM: görünüm katmanı veri çekmez, durum tutmaz',
    content: [
      'View (components/, views/, pages/ altındaki .tsx/.jsx) yalnızca render eder.',
      'Doğrudan fetch çağrısı, useState/useEffect ile veri yükleme ya da yan etki',
      'View içinde YASAKTIR. Veri ve durum bir ViewModel hook\'unda (viewmodels/),',
      'ağ erişimi bir servis modülünde (services/) yaşar. View, ViewModel\'in',
      'döndürdüğü hazır değerleri alır.',
    ].join(' '),
  }),
  Object.freeze({
    ruleId: 'STD-002' as const,
    title: 'MVVM: ViewModel DOM\'a dokunmaz',
    content: [
      'ViewModel katmanı (viewmodels/) saf mantıktır: document, window, querySelector',
      'ya da doğrudan DOM erişimi içeremez. DOM ile konuşan her şey View\'ın işidir.',
      'Bu kural ViewModel\'i tarayıcısız test edilebilir tutar.',
    ].join(' '),
  }),
  Object.freeze({
    ruleId: 'STD-003' as const,
    title: 'Katman yönü: servis UI framework\'ü import etmez',
    content: [
      'Servis katmanı (services/) react ya da başka bir UI framework\'ü import edemez.',
      'Bağımlılık yönü tek yönlüdür: View → ViewModel → Servis. Ters yöndeki her',
      'import katmanları birbirine yapıştırır ve servisi UI olmadan kullanılamaz yapar.',
    ].join(' '),
  }),
  Object.freeze({
    ruleId: 'STD-004' as const,
    title: 'Erişilebilirlik: her form alanının erişilebilir adı olur',
    content: [
      'input, select ve textarea öğeleri ya bir <label> ile bağlanır ya da',
      'aria-label / aria-labelledby taşır. Adı olmayan alan ekran okuyucuda',
      'anlamsızdır ve docs/09 ui_audit denetiminde bulgu açar.',
    ].join(' '),
  }),
]);

/** Aynı proje + kural için HER ZAMAN aynı kimlik: tohumlama tekrarlanabilir. */
function knowledgeIdFor(projectId: string, ruleId: string): EntityId {
  const hex = canonicalSha256V1({ namespace: 'standard-knowledge-v1', projectId, ruleId });
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return EntityIdSchema.parse(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`,
  );
}

export interface StandardKnowledgePorts {
  appendKnowledgeVersion: (row: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Projenin standartlarını yazar. İkinci çağrı yeni satır üretmez:
 * kimlik deterministiktir ve `appendKnowledgeVersion` içerik aynıysa mevcut
 * satırı döndürür.
 */
export async function seedStandardKnowledge(
  ports: StandardKnowledgePorts,
  projectId: EntityId,
  now: string,
): Promise<void> {
  for (const entry of STANDARD_KNOWLEDGE) {
    await ports.appendKnowledgeVersion({
      knowledge_id: knowledgeIdFor(projectId, entry.ruleId),
      project_id: projectId,
      kind: 'standard',
      title: `${entry.ruleId} — ${entry.title}`,
      content: entry.content,
      tags: ['docs/09', entry.ruleId],
      source_task_id: NIL_UUID,
      source_message_id: NIL_UUID,
      status: 'active',
      superseded_by: NIL_UUID,
      created_at: now,
      row_hash: '',
    });
  }
}

/**
 * Birden çok proje için tohumlama (açılışta koşan projeler).
 *
 * Tohumlamayı yalnızca proje AÇILIŞINA bağlamak, hâlihazırda var olan
 * projeleri standartsız bırakırdı. Bir projenin hatası diğerlerini
 * durdurmaz ama SESSİZ de kalmaz: standartsız koşan bir proje, denetçinin
 * hiç söylenmemiş bir kuraldan ceza kesmesi demektir.
 */
export async function seedStandardKnowledgeForProjects(
  ports: StandardKnowledgePorts,
  projectIds: readonly EntityId[],
  now: string,
  onError?: (projectId: EntityId, reason: unknown) => void,
): Promise<void> {
  for (const projectId of projectIds) {
    try {
      await seedStandardKnowledge(ports, projectId, now);
    } catch (reason) {
      onError?.(projectId, reason);
    }
  }
}
