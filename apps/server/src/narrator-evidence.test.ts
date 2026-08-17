import { describe, expect, it } from 'vitest';
import { narrateEvent } from './narrator-evidence.js';

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
});
