import { describe, expect, it } from 'vitest';
import { EntityIdSchema } from '@ww/shared';
import { toolCallEntityId } from './tool-call-id.js';

const invocation = '00000000-0000-4000-8000-000000000001' as never;

describe('toolCallEntityId', () => {
  // ASIL KUSUR: sağlayıcı "call_0_ab12" gibi kimlik üretir; ham doğrulama
  // HER araç çağrısını düşürüyor ve worker dosya yazamıyordu.
  it('sağlayıcı biçimindeki kimliği geçerli EntityId’ye çevirir', () => {
    const id = toolCallEntityId(invocation, 'call_0_ab12cd34');
    expect(EntityIdSchema.safeParse(id).success).toBe(true);
  });

  // Determinizm olmadan aynı çağrı iki kez farklı kimlik alır: idempotency
  // ve denetim izi kopar.
  it('aynı girdi için aynı kimliği üretir', () => {
    expect(toolCallEntityId(invocation, 'call_1')).toBe(toolCallEntityId(invocation, 'call_1'));
  });

  it('farklı çağrı kimliği farklı sonuç verir', () => {
    expect(toolCallEntityId(invocation, 'call_1')).not.toBe(toolCallEntityId(invocation, 'call_2'));
  });

  // Farklı çağrılardaki aynı sıra numarası çakışmamalı.
  it('farklı invocation aynı çağrı kimliğini ayırır', () => {
    const other = '00000000-0000-4000-8000-000000000002' as never;
    expect(toolCallEntityId(invocation, 'call_1')).not.toBe(toolCallEntityId(other, 'call_1'));
  });

  it('zaten UUID olan kimliği korur', () => {
    const uuid = '00000000-0000-4000-8000-0000000000ff';
    expect(toolCallEntityId(invocation, uuid)).toBe(uuid);
  });

  it('boş kimliği reddeder', () => {
    expect(() => toolCallEntityId(invocation, '  ')).toThrow(/boş/);
  });
});
