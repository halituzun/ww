import { describe, expect, it } from 'vitest';
import { narrateEvent } from './narrator-evidence.js';

const event = (type: string, payload: Record<string, unknown>) =>
  ({ event_type: type, payload } as never);

describe('narrateEvent', () => {
  // ASIL KUSUR: cevap ham JSON dökümüydü; okunamaz çıktı boş cevaptan kötüdür.
  it('durum değişimini cümleye çevirir', () => {
    expect(narrateEvent({ event_type: 'status_change', payload: { action: 'fail', toStatus: 'failed' } }))
      .toBe("görev 'fail' ile failed durumuna geçti");
  });

  it('araç çağrısını adıyla anlatır', () => {
    expect(narrateEvent({ event_type: 'tool_call', tool_name: 'write_file' }))
      .toContain('write_file');
  });

  it('kilit olaylarında dosya yolunu verir', () => {
    expect(narrateEvent({ event_type: 'lock_acquired', payload: { path: 'src/Board.tsx' } }))
      .toContain('src/Board.tsx');
  });

  it('kapı sonucunu geçti/geçemedi olarak söyler', () => {
    expect(narrateEvent({ event_type: 'test_run', payload: { passed: true } })).toContain('geçti');
    expect(narrateEvent({ event_type: 'test_run', payload: { passed: false } })).toContain('geçemedi');
  });

  it('hatanın sebebini taşır', () => {
    expect(narrateEvent({ event_type: 'error', payload: { reason: 'model düştü' } }))
      .toContain('model düştü');
  });

  // Sebep kaydedilmemişse bunu söylemek, uydurmaktan iyidir.
  it('sebepsiz hatada bunu belirtir', () => {
    expect(narrateEvent({ event_type: 'error', payload: {} })).toContain('kaydedilmemiş');
  });

  // Bilinmeyen türü JSON'a çevirmek eski okunamaz dökümü geri getirir.
  it('bilinmeyen türde yalnızca tür adını verir', () => {
    expect(narrateEvent({ event_type: 'garip_olay', payload: { a: 1 } })).toBe('garip_olay');
  });

  it('eksik alanlarda uydurma yapmaz', () => {
    expect(narrateEvent({ event_type: 'lock_acquired', payload: {} })).toContain('bilinmiyor');
  });

  // ÖLÇÜLDÜ (canlı ClickHouse, 2026-08-18): 7 olay türü ve 128 olay hiç
  // çevrilmiyordu; anlatı bu satırlarda ham tür adı basıyordu
  // ("policy_decision receipt_changed message_stored"). Üstelik bunlar
  // anlatının EN ÖNEMLİ olayları: commit, tırmandırma, devir.
  //
  // docs/06 "referanslı ANLATI" istiyor; ham tür adı anlatı değildir.
  describe('eksik olay türleri', () => {
    it('commiti hash ile anlatir', () => {
      expect(narrateEvent(event('commit', { commitHash: 'b849854abc' })))
        .toContain('b849854');
    });

    it('commit hashi yoksa uydurmaz', () => {
      expect(narrateEvent(event('commit', {}))).toContain('commit');
    });

    it('tirmandirmayi sebebiyle anlatir', () => {
      expect(narrateEvent(event('escalation', { reason: 'gate failed at attempt limit' })))
        .toContain('gate failed at attempt limit');
    });

    it('gorev devrini anlatir', () => {
      const text = narrateEvent(event('task_handoff', { toAgentId: 'agent-7' }));
      expect(text).toContain('devredildi');
      expect(text).toContain('agent-7');
    });

    it('mesaj kaydini anlatir', () => {
      expect(narrateEvent(event('message_stored', { kind: 'question' })))
        .toContain('question');
    });

    it('reddedilen mesaji sebebiyle anlatir', () => {
      expect(narrateEvent(event('message_rejected', { reason: 'ROUTE_DENIED' })))
        .toContain('ROUTE_DENIED');
    });

    it('politika kararini sonucuyla anlatir', () => {
      expect(narrateEvent(event('policy_decision', { allowed: false, reason: 'bütçe' })))
        .toContain('bütçe');
    });

    it('makbuz degisimini anlatir', () => {
      expect(narrateEvent(event('receipt_changed', { state: 'delivered' })))
        .toContain('delivered');
    });

    // Bilinmeyen tür için ad KORUNUR, uydurulmaz.
    it('bilinmeyen turde ad korunur', () => {
      expect(narrateEvent(event('clone_spawned' as never, {}))).toBe('clone_spawned');
    });
  });
});
