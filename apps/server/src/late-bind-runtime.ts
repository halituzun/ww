// Geç bağlanan portların FİİLEN bağlanması.
//
// NEDEN VAR: `bootstrapOrchestrationRuntime` bir `bindLate` döndürüyordu ama
// hiçbir üretim kodu onu ÇAĞIRMIYORDU. Composition kuruluyor, motor "ETKİN"
// diyor, ama ilk durum geçişinde her görev şu hatayla düşüyordu:
// "taskTransitionService henüz bağlanmadı". Yani motor açıktı ve hiçbir iş
// bitemezdi. Bağlama, composition'ın kurulduğu yere ait.

/** Composition kurulduktan sonra bağlanması gereken servisler. */
const REQUIRED_SERVICES = [
  'taskTransitionService',
  'assignmentService',
  'toolExecutor',
  'gateRunner',
  'gitWorkspace',
] as const;

/** Bağlayıcının beklediği somut şekil; Record ile gevşetmek tip güvenliğini kaybettirir. */
export type LateBoundServices = Readonly<{
  taskTransitionService: object;
  assignmentService: object;
  toolExecutor: object;
  gateRunner: object;
  gitWorkspace: object;
}>;

export type LateBinder = (services: LateBoundServices) => void;

export function applyLateBinding(
  composition: Readonly<Record<string, unknown>>,
  bind: LateBinder | undefined,
): void {
  if (bind === undefined) return;

  const services: Record<string, object> = {};
  const missing: string[] = [];
  for (const name of REQUIRED_SERVICES) {
    const value = composition[name];
    // Eksik servisi sessizce geçmek aynı gizli hatayı geri getirir:
    // port çağrıldığında değil, KURULUMDA patlamalı.
    if (value === undefined || value === null) missing.push(name);
    else services[name] = value as object;
  }
  if (missing.length > 0) {
    throw new Error(`geç bağlanacak servis(ler) composition'da yok: ${missing.join(', ')}`);
  }

  // Eksiklik kontrolü yukarıda yapıldı: şekil artık tam.
  bind(services as unknown as LateBoundServices);
}
