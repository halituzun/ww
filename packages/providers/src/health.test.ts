import { describe, expect, it } from 'vitest';
import { evaluateHealth, DOWN_AFTER_FAILURES, DEGRADED_ERROR_RATE } from './health.js';

describe('evaluateHealth', () => {
  it('ilk başarılı ping ok yapar ve sayacı sıfırlar', () => {
    expect(evaluateHealth({ pingOk: true, consecutiveFailures: 2 }))
      .toEqual({ status: 'ok', consecutiveFailures: 0 });
  });

  it('art arda 3 hatada down olur', () => {
    let failures = 0;
    let status = 'unknown';
    for (let i = 0; i < DOWN_AFTER_FAILURES; i += 1) {
      const result = evaluateHealth({ pingOk: false, consecutiveFailures: failures });
      failures = result.consecutiveFailures;
      status = result.status;
    }
    expect(failures).toBe(DOWN_AFTER_FAILURES);
    expect(status).toBe('down');
  });

  it('3’ten az art arda hatada down demez, degraded der', () => {
    expect(evaluateHealth({ pingOk: false, consecutiveFailures: 0 }))
      .toEqual({ status: 'degraded', consecutiveFailures: 1 });
    expect(evaluateHealth({ pingOk: false, consecutiveFailures: 1 }))
      .toEqual({ status: 'degraded', consecutiveFailures: 2 });
  });

  it('down durumundan tek başarılı pingle çıkar', () => {
    expect(evaluateHealth({ pingOk: true, consecutiveFailures: 5 }).status).toBe('ok');
  });

  it('ping geçse bile son 5 dk hata oranı eşiği aşarsa degraded olur', () => {
    expect(evaluateHealth({ pingOk: true, consecutiveFailures: 0, errorRate: 0.75 }))
      .toEqual({ status: 'degraded', consecutiveFailures: 0 });
  });

  it('eşiğin tam üstü degraded, altı ve eşit ok', () => {
    const justOver = DEGRADED_ERROR_RATE + 0.01;
    expect(evaluateHealth({ pingOk: true, consecutiveFailures: 0, errorRate: justOver }).status).toBe('degraded');
    expect(evaluateHealth({ pingOk: true, consecutiveFailures: 0, errorRate: DEGRADED_ERROR_RATE }).status).toBe('ok');
  });

  it('hata oranı bilinmiyorsa yok sayılır', () => {
    expect(evaluateHealth({ pingOk: true, consecutiveFailures: 0 }).status).toBe('ok');
  });

  it('ping hatası hata oranından baskındır', () => {
    // Ping düşmüşse düşük hata oranı onu iyileştirmemeli.
    expect(evaluateHealth({ pingOk: false, consecutiveFailures: 2, errorRate: 0 }).status).toBe('down');
  });

  it('geçersiz sayaç girdisini reddeder', () => {
    // Not: Türkçe ünsüz yumuşaması — "sayacı" içinde "sayaç" geçmez.
    expect(() => evaluateHealth({ pingOk: true, consecutiveFailures: -1 })).toThrow(/saya[çc]/i);
  });
});
