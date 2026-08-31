// Emülatör önizleme hedefleri — docs/10 "Android Emülatör → AVD tespiti".
//
// NEDEN VAR: uç yalnız `listAvds`'ı yayınlıyordu ve o `emulator` ikilisini
// çağırır. O paket kurulu değilken (yaygın: platform-tools var, emulator yok)
// uç düşüyor ve panel "hiçbir şey yok" diyordu — oysa `adb devices` iki
// gerçek cihaz gösteriyordu. Bağlı cihaz varken önizleme MÜMKÜNDÜR.

export interface MobileTargets {
  /** Şu an bağlı cihaz seri numaraları (`adb devices`). */
  readonly devices: readonly string[];
  /** Başlatılabilir AVD adları (`emulator -list-avds`). */
  readonly avds: readonly string[];
  /** Herhangi bir hedef var mı? */
  readonly available: boolean;
}

const clean = (values: readonly string[]): readonly string[] =>
  Object.freeze([...new Set(values.filter((value) => value.trim() !== ''))].sort());

export function mobileTargets(
  devices: readonly string[],
  avds: readonly string[],
): MobileTargets {
  const uniqueDevices = clean(devices);
  const uniqueAvds = clean(avds);
  return Object.freeze({
    devices: uniqueDevices,
    avds: uniqueAvds,
    available: uniqueDevices.length > 0 || uniqueAvds.length > 0,
  });
}
