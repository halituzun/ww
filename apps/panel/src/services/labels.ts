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

const HEALTH: Readonly<Record<string, string>> = Object.freeze({
  ok: 'sağlıklı',
  degraded: 'zayıf',
  down: 'düştü',
  unknown: 'bilinmiyor',
});

/** Bilinmeyen değerde ad KORUNUR; uydurma çeviri olmayan bir anlam verir. */
const lookup = (table: Readonly<Record<string, string>>, value: string): string =>
  table[value] ?? value;

export const projectStatusLabel = (value: string): string => lookup(PROJECT, value);
export const agentStatusLabel = (value: string): string => lookup(AGENT_STATUS, value);
export const agentRoleLabel = (value: string): string => lookup(AGENT_ROLE, value);
export const healthStatusLabel = (value: string): string => lookup(HEALTH, value);

const AUDIT_PROFILE: Readonly<Record<string, string>> = Object.freeze({
  verifier: 'doğrulayıcı',
  communication_audit: 'iletişim denetimi',
});

export const auditProfileLabel = (value: string): string => lookup(AUDIT_PROFILE, value);

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

export const messageKindLabel = (value: string): string => lookup(MESSAGE_KIND, value);
