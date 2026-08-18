import { describe, expect, it } from 'vitest';
import {
  AGENT_ROLES, AGENT_STATUSES, AUDIT_FINDING_PROFILES, HEALTH_STATUSES, MESSAGE_KINDS,
  PROJECT_STATUSES,
} from '@ww/shared';
import {
  agentRoleLabel, agentStatusLabel, auditProfileLabel, healthStatusLabel, messageKindLabel,
  projectStatusLabel,
} from './labels.js';

// Karar K6: panel dili Türkçe. Ham iç kimliğin kullanıcı yüzeyine sızması,
// anlatıcının ham olay adı basmasıyla aynı kusurdur.
//
// Her kapsam testi ŞEMADAN besleniyor: yeni bir değer eklenip etiketi
// yazılmazsa test o turda düşer. Tek seferlik betikle ölçmek bu oturumda
// bir kez yanlış rapora yol açtı.
describe('etiket kapsamı', () => {
  it.each([
    ['proje durumu', PROJECT_STATUSES, projectStatusLabel],
    ['agent durumu', AGENT_STATUSES, agentStatusLabel],
    ['agent rolü', AGENT_ROLES, agentRoleLabel],
    ['sağlık durumu', HEALTH_STATUSES, healthStatusLabel],
    ['denetim profili', AUDIT_FINDING_PROFILES, auditProfileLabel],
    ['mesaj türü', MESSAGE_KINDS, messageKindLabel],
  ])('%s: her deger icin etiket var', (_name, values, label) => {
    expect((values as readonly string[]).filter((value) => label(value) === value)).toEqual([]);
  });
});

describe('etiketler', () => {
  it('bilinen degerleri cevirir', () => {
    expect(projectStatusLabel('running')).toBe('çalışıyor');
    expect(agentStatusLabel('waiting_answer')).toBe('cevap bekliyor');
    expect(agentRoleLabel('standards_auditor')).toBe('standart denetçisi');
    expect(healthStatusLabel('down')).toBe('düştü');
  });

  // Bilinmeyen değerde ad KORUNUR: anlamadığı bir kimliği Türkçeleştirmek
  // kullanıcıya olmayan bir anlam verir.
  it('bilinmeyen degerde ad korunur', () => {
    expect(projectStatusLabel('gelecek')).toBe('gelecek');
    expect(agentRoleLabel('gelecek')).toBe('gelecek');
  });
});
