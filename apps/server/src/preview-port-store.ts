// Önizleme portunun KALICI kaydı (docs/05 → "port havuzu … `projects.settings
// .dev_port`'a yazılır").
//
// NEDEN VAR: port yalnızca sürecin belleğindeki havuzdaydı. Sunucu yeniden
// başlayınca aynı projeye başka bir port düşebiliyordu — oysa port havuzunu
// yazarken kendi gerekçem "yeniden başlatmada portun değişmesi paneldeki
// iframe'i sessizce kırar" idi. Bellek, süreç ömründen uzun yaşamaz.
export const DEV_PORT_KEY = 'dev_port';

export type ProjectSettings = Readonly<Record<string, unknown>>;

/** Kayıtlı port; yoksa ya da bozuksa `undefined` (uydurma yapılmaz). */
export function readDevPort(settings: unknown, min: number, max: number): number | undefined {
  if (typeof settings !== 'object' || settings === null) return undefined;
  const raw = (settings as Record<string, unknown>)[DEV_PORT_KEY];
  const port = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isSafeInteger(port) || port < min || port > max) return undefined;
  return port;
}

/** Portu ayarlara yazar; diğer ayarlara DOKUNMAZ. */
export function withDevPort(settings: unknown, port: number): ProjectSettings {
  const base = typeof settings === 'object' && settings !== null
    ? { ...(settings as Record<string, unknown>) }
    : {};
  return Object.freeze({ ...base, [DEV_PORT_KEY]: port });
}

/** Portu ayarlardan siler; süreç kapanınca kayıt yalan söylememeli. */
export function withoutDevPort(settings: unknown): ProjectSettings {
  const base = typeof settings === 'object' && settings !== null
    ? { ...(settings as Record<string, unknown>) }
    : {};
  delete base[DEV_PORT_KEY];
  return Object.freeze(base);
}
