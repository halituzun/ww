// Konseyin nihai sentezinden organizasyon planı.
//
// NEDEN VAR: `deriveOrgPlan` org planını konsey ÇIKTISINDAN DEĞİL, sabit bir
// kelime listesinden türetiyordu:
//
//   lower.includes('tetris') || lower.includes('pomodoro') ||
//   lower.includes('zamanlayıcı') || lower.includes('hesap') || ...
//
// `result.finalSynthesis` metni hiç okunmuyordu. Model ne derse desin sonuç
// iki sabit şablondan biriydi (biri "Oyun Mantığı & Çekirdek Motor"
// departmanı içerir) ve "Zamanlayıcı servisini yeniden yaz" gibi büyük bir
// backend işi "küçük proje" sayılıp iki departmana indirgeniyordu. Tahmini
// bütçe de sabitti (18000 token / $0.045) ve panelde gerçek tahmin gibi
// gösteriliyordu.

import { AGENT_GROUPS, type OrgDepartment, type OrgPlan } from '@ww/shared';

export class OrgPlanParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrgPlanParseError';
  }
}

// Ayırıcı BOŞLUKLA çevrilidir; aksi hâlde `dept-api` gibi tireli bir
// kimlik ilk tireden bölünür ve 'dept' olarak okunurdu.
const DEPT_HEADING = /^###\s*DEPARTMAN\s+(\S+)\s+[—–-]\s+(.+)$/u;
const FIELD = /^([A-ZÇĞİÖŞÜ]+):\s*(.*)$/u;

const splitList = (value: string): string[] =>
  value.split(/[|,;]/u).map((part) => part.trim()).filter((part) => part !== '');

const count = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt((value ?? '').trim(), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 8 ? parsed : fallback;
};

/**
 * Nihai sentezdeki `## DEPARTMANLAR` bölümünü ayrıştırır.
 *
 * Bölüm yoksa BOŞ dizi döner — çağıran taraf bunu açıkça ele alır; sessizce
 * sabit bir şablona düşmek, düzeltilen kusurun ta kendisidir.
 */
export function parseDepartmentsFromMarkdown(markdown: string): readonly OrgDepartment[] {
  const section = /##\s*DEPARTMANLAR\s*\n([\s\S]*?)(?=\n##\s|$)/u.exec(markdown);
  if (section === null) return [];

  const departments: OrgDepartment[] = [];
  let current: { id: string; name: string; fields: Map<string, string> } | null = null;

  const flush = (): void => {
    if (current === null) return;
    const fields = current.fields;
    const groupRaw = (fields.get('GRUP') ?? 'coding').trim();
    const group = (AGENT_GROUPS as readonly string[]).includes(groupRaw) ? groupRaw : 'coding';
    const patterns = splitList(fields.get('DOSYALAR') ?? '');
    if (patterns.length === 0) {
      throw new OrgPlanParseError(
        `departman sorumluluk deseni tasimiyor: ${current.id}`,
      );
    }

    departments.push({
      id: current.id,
      name: current.name,
      group,
      lead_role: 'group_lead',
      members: [
        { role: 'worker', count: count(fields.get('YAPAN'), 1), model_tier: 'medium' },
        { role: 'verifier', count: count(fields.get('DENETLEYEN'), 1), model_tier: 'medium' },
      ],
      responsibility_patterns: patterns,
      rationale: (fields.get('GEREKÇE') ?? '').trim(),
    });
    current = null;
  };

  for (const line of (section[1] ?? '').split('\n')) {
    const heading = DEPT_HEADING.exec(line.trim());
    if (heading !== null) {
      flush();
      current = { id: heading[1]!.trim(), name: heading[2]!.trim(), fields: new Map() };
      continue;
    }
    if (current === null) continue;
    const field = FIELD.exec(line.trim());
    if (field !== null) current.fields.set(field[1]!, field[2]!.trim());
  }
  flush();

  return Object.freeze(departments);
}

/**
 * Konsey sentezinden tam org planı.
 *
 * Bütçe alanları SIFIRDIR ve bu bilinçlidir: elimizde gerçek bir tahmin yok.
 * Eski kod sabit 18000 token / $0.045 yazıyor, panel de bunu gerçek tahmin
 * gibi gösteriyordu. Sıfır "hesaplanmadı" demektir ve panel öyle gösterir —
 * uydurma bir sayı göstermekten iyidir.
 */
export function orgPlanFromSynthesis(markdown: string): OrgPlan | undefined {
  const departments = parseDepartmentsFromMarkdown(markdown);
  if (departments.length === 0) return undefined;

  const nonDepartmentRoles = [
    { role: 'pm', reports_to: 'user', rationale: 'Genel koordinasyon, kullanıcı iletişimi ve plan onayı' },
    { role: 'interviewer', reports_to: 'pm', rationale: 'Gereksinim analizi ve kullanıcı görüşmesi' },
    { role: 'standards_auditor', reports_to: 'pm', rationale: 'MVVM ve kod kalite denetimi' },
    // Anlatıcı yalnız büyük organizasyonlarda anlamlı: iki departmanlı bir
    // projede olay akışını izlemek için ayrı bir role gerek yok.
    ...(departments.length >= 3
      ? [{ role: 'narrator', reports_to: 'pm', rationale: 'Olay izleme ve süreç anlatımı' }]
      : []),
  ];

  return Object.freeze({
    departments,
    non_department_roles: Object.freeze(nonDepartmentRoles),
    // Eşzamanlılık departman sayısına bağlanır ama sağlayıcı rate limitini
    // zorlamamak için üstten sınırlanır (docs/07).
    concurrency_limit: Math.max(2, Math.min(4, departments.length)),
    estimated_tokens: 0,
    estimated_cost_usd: 0,
  });
}
