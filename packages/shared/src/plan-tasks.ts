import { z } from 'zod';
import { AGENT_GROUPS } from './constants.js';

/**
 * Plan → görev sözleşmesi.
 *
 * NEDEN VAR: plan onayı hiçbir görev üretmiyordu. Panel "Görevler yürütmeye
 * alındı" diyor, kuyruk boş kalıyordu. Kopukluğun kökü şuydu: konsey planı
 * yalnız SERBEST METİN üretiyor (BULGU/KARAR blokları), içinde makine
 * tarafından okunabilir bir iş kırılımı yok. Bu dosya o kırılımın
 * sözleşmesini ve ayrıştırıcısını tanımlar.
 *
 * Görevler plan satırının `scenarios_json` alanında saklanır: alan zaten
 * vardı, her yerde `{ scenarios: [] }` olarak boş yazılıyordu ve hiçbir
 * üretim kodu okumuyordu.
 */

const KEY_SCHEMA = z.string().trim().min(1).max(64);

export const PlanTaskSpecV1Schema = z.strictObject({
  /** Plan içi kimlik; bağımlılıklar bu anahtara referans verir. */
  key: KEY_SCHEMA,
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().default(''),
  acceptanceCriteria: z.array(z.string().trim().min(1)).min(1),
  /**
   * BOŞ OLAMAZ. Executor boş hedef listesini "hiçbir dosya yazılamaz" diye
   * uygular ve `write_file`'ı reddeder; hedefsiz görev hiçbir şey üretemez.
   * Bu kuralı sözleşmede zorlamak, onay anında yakalamayı sağlar — koşu
   * sırasında sessizce takılmak yerine.
   */
  targetFiles: z.array(z.string().trim().min(1)).min(1),
  dependsOn: z.array(KEY_SCHEMA).default([]),
  group: z.enum(AGENT_GROUPS).default('coding'),
}).readonly();

export type PlanTaskSpecV1 = z.infer<typeof PlanTaskSpecV1Schema>;

export const PlanTaskGraphV1Schema = z.strictObject({
  version: z.literal(1),
  tasks: z.array(PlanTaskSpecV1Schema),
}).readonly();

export type PlanTaskGraphV1 = z.infer<typeof PlanTaskGraphV1Schema>;

export class PlanTaskGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanTaskGraphError';
  }
}

/** `scenarios_json` içinden görev grafiğini okur. Yoksa boş grafik döner. */
export function readPlanTaskGraph(scenariosJson: unknown): PlanTaskGraphV1 {
  if (scenariosJson === null || scenariosJson === undefined) {
    return { version: 1, tasks: [] };
  }
  const raw = typeof scenariosJson === 'string'
    ? safeJsonParse(scenariosJson)
    : scenariosJson;
  const candidate = (raw as { tasks?: unknown } | null)?.tasks;
  if (candidate === undefined) return { version: 1, tasks: [] };

  const parsed = PlanTaskGraphV1Schema.safeParse({ version: 1, tasks: candidate });
  if (!parsed.success) {
    // Bozuk grafiği SESSİZCE boş saymak, "plan onaylandı ama görev yok"
    // yalanını geri getirirdi.
    throw new PlanTaskGraphError(`plan gorev grafigi gecersiz: ${parsed.error.message}`);
  }
  return parsed.data;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new PlanTaskGraphError('plan gorev grafigi JSON olarak cozulemedi');
  }
}

/**
 * Bağımlılık sırasına göre dizer. Görevler oluşturulurken üst görevin kimliği
 * gerekir; sıralama olmadan `depends_on` çözülemez.
 *
 * Bilinmeyen anahtar ve döngü FAIL-CLOSED reddedilir: yarım bir grafikten
 * görev üretmek, çalışmayacak bir kuyruk doldurmak demektir.
 */
export function topologicalPlanTaskOrder(
  tasks: readonly PlanTaskSpecV1[],
): readonly PlanTaskSpecV1[] {
  const byKey = new Map<string, PlanTaskSpecV1>();
  for (const task of tasks) {
    if (byKey.has(task.key)) {
      throw new PlanTaskGraphError(`plan gorev anahtari tekrar ediyor: ${task.key}`);
    }
    byKey.set(task.key, task);
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!byKey.has(dependency)) {
        throw new PlanTaskGraphError(
          `plan gorevi bilinmeyen bagimliliga referans veriyor: ${task.key} -> ${dependency}`,
        );
      }
    }
  }

  const ordered: PlanTaskSpecV1[] = [];
  const state = new Map<string, 'visiting' | 'done'>();

  const visit = (task: PlanTaskSpecV1, trail: readonly string[]): void => {
    const current = state.get(task.key);
    if (current === 'done') return;
    if (current === 'visiting') {
      throw new PlanTaskGraphError(
        `plan gorev grafiginde dongu var: ${[...trail, task.key].join(' -> ')}`,
      );
    }
    state.set(task.key, 'visiting');
    for (const dependency of task.dependsOn) {
      visit(byKey.get(dependency)!, [...trail, task.key]);
    }
    state.set(task.key, 'done');
    ordered.push(task);
  };

  for (const task of tasks) visit(task, []);
  return Object.freeze(ordered);
}

const TASK_HEADING = /^###\s*GÖREV\s+([^\s—-]+)\s*[—-]\s*(.+)$/u;
const FIELD = /^([A-ZÇĞİÖŞÜ]+):\s*(.*)$/u;

/**
 * Nihai sentezdeki `## GÖREVLER` bölümünü ayrıştırır.
 *
 * Beklenen biçim (prompt bunu zorunlu kılar):
 *
 * ```
 * ## GÖREVLER
 * ### GÖREV g1 — Oyun tahtasını çiz
 * DOSYALAR: src/board.ts, src/styles.css
 * KABUL: 10x20 ızgara çizilir | boş hücreler görünür
 * BAĞIMLI: -
 * GRUP: coding
 * AÇIKLAMA: ...
 * ```
 *
 * Ayrıştırılamayan blok SESSİZCE atlanmaz; bölüm hiç yoksa boş dizi döner ve
 * çağıran taraf bunu açıkça hata olarak ele alır.
 */
export function parsePlanTasksFromMarkdown(markdown: string): readonly PlanTaskSpecV1[] {
  const section = /##\s*GÖREVLER\s*\n([\s\S]*?)(?=\n##\s|$)/u.exec(markdown);
  if (section === null) return [];

  const lines = (section[1] ?? '').split('\n');
  const specs: PlanTaskSpecV1[] = [];
  let current: { key: string; title: string; fields: Map<string, string> } | null = null;

  const flush = (): void => {
    if (current === null) return;
    const fields = current.fields;
    const files = splitList(fields.get('DOSYALAR') ?? '');
    const criteria = splitList(fields.get('KABUL') ?? '');
    const dependsOn = splitList(fields.get('BAĞIMLI') ?? '').filter((d) => d !== '-' && d !== 'yok');
    const groupRaw = (fields.get('GRUP') ?? 'coding').trim();

    const parsed = PlanTaskSpecV1Schema.safeParse({
      key: current.key,
      title: current.title,
      description: fields.get('AÇIKLAMA') ?? '',
      acceptanceCriteria: criteria,
      targetFiles: files,
      dependsOn,
      group: (AGENT_GROUPS as readonly string[]).includes(groupRaw) ? groupRaw : 'coding',
    });
    if (!parsed.success) {
      throw new PlanTaskGraphError(
        `plan gorevi eksik veya gecersiz (${current.key}): ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`,
      );
    }
    specs.push(parsed.data);
    current = null;
  };

  for (const line of lines) {
    const heading = TASK_HEADING.exec(line.trim());
    if (heading !== null) {
      flush();
      current = { key: heading[1]!.trim(), title: heading[2]!.trim(), fields: new Map() };
      continue;
    }
    if (current === null) continue;
    const field = FIELD.exec(line.trim());
    if (field !== null) current.fields.set(field[1]!, field[2]!.trim());
  }
  flush();

  return Object.freeze(specs);
}

const splitList = (value: string): string[] =>
  value
    .split(/[|,;]/u)
    .map((part) => part.trim())
    .filter((part) => part !== '');
