// Sağlayıcının araç çağrısı kimliğini kanonik EntityId'ye çevirir.
//
// NEDEN VAR: sistem her araç çağrısı için UUID (EntityId) bekliyor, ama
// sağlayıcılar kendi biçimlerini üretir (DeepSeek/OpenAI: "call_0_ab12...").
// Ham kimliği doğrulamak HER araç çağrısını düşürüyordu: worker kod üretiyor
// ama write_file çağrısı reddedildiği için dosya hiç yazılmıyordu.
//
// Türetme DETERMİNİSTİK olmalı: aynı çağrı tekrar işlenirse aynı kimliği
// üretmeli, yoksa idempotency ve denetim izi kopar.
import { EntityIdSchema, canonicalSha256V1, type EntityId } from '@ww/shared';

export function toolCallEntityId(
  invocationId: EntityId,
  providerCallId: string,
): EntityId {
  // Zaten kanonik bir UUID ise olduğu gibi korunur: iz sürmeyi bozmayalım.
  const direct = EntityIdSchema.safeParse(providerCallId);
  if (direct.success) return direct.data;

  if (providerCallId.trim() === '') {
    throw new Error('sağlayıcı araç çağrısı kimliği boş olamaz');
  }

  const hex = canonicalSha256V1({
    namespace: 'provider-tool-call-v1',
    invocationId,
    providerCallId,
  });
  return EntityIdSchema.parse(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`,
  );
}
