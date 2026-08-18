// Agent'ın körlüğünü kapatan araçların sözleşmesi.
//
// NEDEN VAR: docs/05 ondokuz araç tanımlıyordu, executor sekizini
// uyguluyordu. Eksikler yüzünden worker canlı koşuda dosyaları göremiyor,
// arama yapamıyor, işi bölemiyor ve geçmiş kararlara ulaşamıyordu — her biri
// bir kullanıcı sorusuna dönüşüyordu.
import { describe, expect, it } from 'vitest';
import { EXECUTOR_TOOL_CAPABILITIES } from './capability-policy.js';
import { TOOL_NAMES, executorToolRegistry } from './tool-registry.js';

describe('araç kaydı', () => {
  const added = [
    'list_dir', 'search_code', 'memory_query', 'create_subtask',
    'record_knowledge', 'record_artifact',
    'move_file', 'delete_file', 'git_log',
  ] as const;

  it('yeni araclarin hepsi kayitli', () => {
    for (const name of added) expect(TOOL_NAMES).toContain(name);
  });

  // Şeması olmayan araç modele tanıtılamaz; kayıt sessizce yarım kalırdı.
  it('her aracin semasi vardir', () => {
    for (const name of TOOL_NAMES) {
      expect(executorToolRegistry.definition(name).parameters).toBeDefined();
    }
  });

  // Yetki tanımı olmayan araç politikadan geçemez.
  it('her aracin yetki tanimi vardir', () => {
    for (const name of TOOL_NAMES) {
      expect(EXECUTOR_TOOL_CAPABILITIES[name]).toBeDefined();
    }
  });

  // GÖRME araçları mühürlü hedef listesiyle sınırlanmamalıdır: aksi halde
  // worker yalnızca zaten bildiği dosyaları görebilir ve araç anlamsızdır.
  it('gorme araclari hedef listesi istemez', () => {
    for (const name of ['list_dir', 'search_code', 'memory_query'] as const) {
      expect(EXECUTOR_TOOL_CAPABILITIES[name].requiresDeclaredTarget).toBe(false);
    }
  });

  // Alt görev açmak durum değiştirir ve kaynak harcar.
  it('alt gorev araci yalnizca calisan gorevde ve worker rolundedir', () => {
    const capability = EXECUTOR_TOOL_CAPABILITIES['create_subtask'];
    expect(capability.allowedRoles).toEqual(['worker']);
    expect(capability.allowedTaskStatuses).toEqual(['working']);
  });

  // Aynı çağrı iki kez alt görev AÇMAMALIDIR.
  it('alt gorev araci tekrar guvenli sayilmaz', () => {
    expect(EXECUTOR_TOOL_CAPABILITIES['create_subtask'].replaySafety).toBe('non_replay_safe');
  });

  // Okuma araçları tekrar güvenlidir; aksi halde her yeniden deneme
  // gereksizce tırmandırılır.
  it('okuma araclari tekrar guvenlidir', () => {
    for (const name of ['list_dir', 'search_code', 'memory_query'] as const) {
      expect(EXECUTOR_TOOL_CAPABILITIES[name].replaySafety).toBe('replay_safe');
    }
  });

  // KALICI YAZAN araçlar tekrar güvenli sayılmamalıdır: aynı çağrının iki kez
  // yazması aynı kararı/çıktıyı iki kez kaydeder.
  it('kalici yazan araclar tekrar guvenli sayilmaz', () => {
    for (const name of ['record_knowledge', 'record_artifact'] as const) {
      expect(EXECUTOR_TOOL_CAPABILITIES[name].replaySafety).toBe('non_replay_safe');
    }
  });

  // Dosya sistemini değiştiren araçlar kilit ister; kilitsiz yazma iki
  // worker'ın aynı dosyayı ezmesine yol açar.
  it('tasima ve silme kilit ister', () => {
    for (const name of ['move_file', 'delete_file'] as const) {
      expect(EXECUTOR_TOOL_CAPABILITIES[name].requiresFileLock).toBe(true);
      expect(EXECUTOR_TOOL_CAPABILITIES[name].requiresDeclaredTarget).toBe(true);
    }
  });

  // git_log salt okumadır; verifier'ın da erişmesi gerekir.
  it('git_log salt okuma ve verifiera aciktir', () => {
    const capability = EXECUTOR_TOOL_CAPABILITIES['git_log'];
    expect(capability.replaySafety).toBe('replay_safe');
    expect(capability.allowedRoles).toContain('verifier');
  });

  // Agent ÜRETMEDİĞİ bir dosyayı kendi çıktısı gibi kaydedememeli.
  it('cikti kaydi muhurlu hedef ister', () => {
    expect(EXECUTOR_TOOL_CAPABILITIES['record_artifact'].requiresDeclaredTarget).toBe(true);
  });
});
