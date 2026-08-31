// Panelin Türkçe etiketleri (karar K6: "Panel dili Türkçe, agent içi
// İngilizce").
//
// NEDEN VAR: proje durumu, agent rolü/durumu ve sağlayıcı sağlığı panelde HAM
// İNGİLİZCE kimlik olarak basılıyordu. İç tanımlayıcının kullanıcı yüzeyine
// sızması, anlatıcının ham olay adı basmasıyla aynı kusurdur.
//
// Her sözlüğün kapsamı ŞEMAYA karşı test edilir: yeni bir değer eklenip
// etiketi yazılmazsa test düşer.

const PROJECT: Readonly<Record<string, string>> = Object.freeze({
  draft: 'taslak',
  gathering: 'gereksinim toplanıyor',
  planning: 'planlanıyor',
  running: 'çalışıyor',
  paused: 'duraklatıldı',
  completed: 'tamamlandı',
  archived: 'arşivlendi',
});

const AGENT_STATUS: Readonly<Record<string, string>> = Object.freeze({
  idle: 'boşta',
  busy: 'meşgul',
  waiting_verify: 'doğrulama bekliyor',
  waiting_answer: 'cevap bekliyor',
  stopped: 'durduruldu',
});

const AGENT_ROLE: Readonly<Record<string, string>> = Object.freeze({
  pm: 'proje yöneticisi',
  council_member: 'konsey üyesi',
  group_lead: 'grup lideri',
  interviewer: 'görüşmeci',
  worker: 'yapan',
  verifier: 'denetleyen',
  standards_auditor: 'standart denetçisi',
  researcher: 'araştırmacı',
  professor: 'profesör',
  creator: 'yaratıcı',
  summarizer: 'özetleyici',
  narrator: 'anlatıcı',
});

const AGENT_GROUP: Readonly<Record<string, string>> = Object.freeze({
  management: 'yönetim',
  analysis: 'analiz',
  design: 'tasarım',
  db: 'veritabanı',
  coding: 'kodlama',
  research: 'araştırma',
  reasoning: 'çıkarım',
  ui_audit: 'arayüz denetimi',
  mvvm_audit: 'mvvm denetimi',
  db_write_audit: 'yazma denetimi',
});

const HEALTH: Readonly<Record<string, string>> = Object.freeze({
  ok: 'sağlıklı',
  degraded: 'zayıf',
  down: 'düştü',
  unknown: 'bilinmiyor',
});

const AUDIT_PROFILE: Readonly<Record<string, string>> = Object.freeze({
  verifier: 'doğrulayıcı',
  communication_audit: 'iletişim denetimi',
});

const MESSAGE_KIND: Readonly<Record<string, string>> = Object.freeze({
  question: 'soru',
  answer: 'cevap',
  order: 'emir',
  proposal: 'öneri',
  objection: 'itiraz',
  synthesis: 'sentez',
  report: 'rapor',
  escalation: 'tırmandırma',
  user_command: 'kullanıcı emri',
  verdict: 'karar',
});

/** Bilinmeyen değerde ad KORUNUR; uydurma çeviri olmayan bir anlam verir. */
const lookup = (table: Readonly<Record<string, string>>, value: string): string =>
  table[value] ?? value;

const TASK_STATUS: Readonly<Record<string, string>> = Object.freeze({
  queued: 'kuyrukta',
  working: 'çalışıyor',
  verifying: 'doğrulanıyor',
  testing: 'test ediliyor',
  done: 'tamamlandı',
  rejected: 'reddedildi',
  failed: 'başarısız',
  blocked: 'engellendi',
});

export const taskStatusLabel = (value: string): string => lookup(TASK_STATUS, value);
export const projectStatusLabel = (value: string): string => lookup(PROJECT, value);
export const agentStatusLabel = (value: string): string => lookup(AGENT_STATUS, value);
export const agentRoleLabel = (value: string): string => lookup(AGENT_ROLE, value);
export const agentGroupLabel = (value: string): string => lookup(AGENT_GROUP, value);
export const taskGroupLabel = (value: string): string => lookup(AGENT_GROUP, value);
export const healthStatusLabel = (value: string): string => lookup(HEALTH, value);
export const auditProfileLabel = (value: string): string => lookup(AUDIT_PROFILE, value);
export const messageKindLabel = (value: string): string => lookup(MESSAGE_KIND, value);

const MODEL_TIER: Readonly<Record<string, string>> = Object.freeze({
  heavy: 'ağır katman',
  medium: 'orta katman',
  fast: 'hafif katman',
  light: 'hafif katman',
});

const REPORTS_TO: Readonly<Record<string, string>> = Object.freeze({
  user: 'kullanıcı',
  pm: 'PM',
  group_lead: 'grup lideri',
});

export const modelTierLabel = (value: string): string => lookup(MODEL_TIER, value);
export const reportsToLabel = (value: string): string => lookup(REPORTS_TO, value);

/**
 * Süre biçimlendirme kuralı:
 * - < 60 saniye: "45 sn"
 * - < 60 dakika: "15 dk 20 sn"
 * - >= 60 dakika: "2 sa 55 dk"
 */
export function formatElapsed(sec?: number): string {
  if (!sec || sec <= 0) return "";
  const totalSec = Math.floor(sec);
  if (totalSec < 60) return `${totalSec} sn`;
  const totalMin = Math.floor(totalSec / 60);
  const remSec = totalSec % 60;
  if (totalMin < 60) {
    return remSec > 0 ? `${totalMin} dk ${remSec} sn` : `${totalMin} dk`;
  }
  const hours = Math.floor(totalMin / 60);
  const remMin = totalMin % 60;
  return remMin > 0 ? `${hours} sa ${remMin} dk` : `${hours} sa`;
}

export function cleanRoleName(role: string): string {
  if (role === "pm") return "PM";
  if (role === "interviewer") return "Görüşmeci";
  if (role === "standards_auditor") return "Standart Denetçisi";
  if (role === "group_lead") return "Grup Lideri";
  if (role === "worker") return "Yapan";
  if (role === "verifier") return "Denetleyen";
  return agentRoleLabel(role);
}
