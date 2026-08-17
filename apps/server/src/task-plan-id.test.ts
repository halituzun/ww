import { describe, expect, it } from 'vitest';
import { NIL_UUID } from '@ww/shared';
import { TaskPlanError, resolveTaskPlanId } from './task-plan-id.js';

const plan = (id: string, version: string) => ({ plan_id: id, version });
const none = { approved: [], proposed: [] };

describe('resolveTaskPlanId', () => {
  it('cagiranin verdigi plani kullanir', () => {
    expect(resolveTaskPlanId('p-verilen', { approved: [plan('p-onayli', '1')], proposed: [] }))
      .toBe('p-verilen');
  });

  // ASIL KUSUR: plan verilmeyince NIL_UUID yazılıyordu; atama bunu reddedince
  // görev "queued" görünüp hiç çalışmıyordu.
  it('plan verilmeyince projenin onayli planini secer', () => {
    expect(resolveTaskPlanId(undefined, { approved: [plan('p-onayli', '3')], proposed: [] }))
      .toBe('p-onayli');
  });

  it('NIL plan kimligini verilmemis sayar', () => {
    expect(resolveTaskPlanId(NIL_UUID, { approved: [plan('p-onayli', '1')], proposed: [] }))
      .toBe('p-onayli');
  });

  it('bos plan kimligini verilmemis sayar', () => {
    expect(resolveTaskPlanId('', { approved: [plan('p-onayli', '1')], proposed: [] }))
      .toBe('p-onayli');
  });

  // Sürüm UInt64 string'idir: metinsel karşılaştırma "10" < "9" der ve
  // eski plan seçilirdi.
  it('ayni statude en yeni surumu sayisal secer', () => {
    expect(resolveTaskPlanId(undefined, {
      approved: [plan('p-eski', '9'), plan('p-yeni', '10')], proposed: [],
    })).toBe('p-yeni');
  });

  it('onayli plan yoksa onerilmis plana duser', () => {
    expect(resolveTaskPlanId(undefined, { approved: [], proposed: [plan('p-oneri', '2')] }))
      .toBe('p-oneri');
  });

  it('onayli plan varken onerilmisi tercih etmez', () => {
    expect(resolveTaskPlanId(undefined, {
      approved: [plan('p-onayli', '1')], proposed: [plan('p-oneri', '99')],
    })).toBe('p-onayli');
  });

  // Sessizce plansız görev açmak, hiç koşmayacak bir görevi "açıldı" diye
  // kullanıcıya göstermek demektir.
  it('hic plan yoksa acik hata verir', () => {
    expect(() => resolveTaskPlanId(undefined, none)).toThrow(TaskPlanError);
    expect(() => resolveTaskPlanId(undefined, none)).toThrow(/plan bulunamadi/);
  });
});
