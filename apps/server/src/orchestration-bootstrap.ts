// Orkestrasyon runtime'ının nihai birleştirmesi.
//
// Tüm parçalar hazırdı ama onları kurup `registerPhase9RuntimeConfig`'i
// çağıran kimse yoktu: server REST/WebSocket/migration/recovery koşuyor ama
// görev kuyruğunu tüketen bir motor başlamıyordu. Bu modül o boşluğu kapatır.
//
// FAIL-CLOSED: eksik yapılandırmayla motoru başlatmak her görevi anında
// hataya sürer. Sağlayıcı yoksa veya rol eşlemesi eksikse kayıt YAPILMAZ ve
// sebep açıkça döner; `GET /runtime` bunu gösterir.
import type { ClickHouseClient, WwRedis } from '@ww/db';
import type { LlmProvider, RoutingIndex, SkippedProvider } from '@ww/providers';
import type { EntityId } from '@ww/shared';
import { resolveRuntimeModels, resolveWorkspaceRoot } from './runtime-context.js';
import type { AssemblyResult } from './orchestration-assembly.js';

export interface BootstrapDeps {
  ch: ClickHouseClient;
  redis: WwRedis;
  projectId: EntityId;
  projectSlug: string;
  workspaceRoot: string;
  localSessionToken: string;
  consumerId: string;
  loadProviders: () => Promise<{
    providers: Map<string, LlmProvider>;
    skipped: readonly SkippedProvider[];
  }>;
  loadRouting: () => Promise<RoutingIndex>;
  register: (config: {
    composition: AssemblyResult['composition'];
    bindLate: AssemblyResult['bindLate'];
  }) => void;
}

export interface BootstrapResult {
  registered: boolean;
  /** Composition kurulduktan sonra çağrılmalı (geç bağlanan portlar). */
  bindLate?: AssemblyResult['bindLate'];
  reason?: string;
  workerModelRef?: string;
  verifierModelRef?: string;
  warning?: string;
}

export async function bootstrapOrchestrationRuntime(deps: BootstrapDeps): Promise<BootstrapResult> {
  // 1) Workspace sınırı: geçersiz slug sandbox hapsini deler.
  let projectRoot: string;
  try {
    projectRoot = resolveWorkspaceRoot(deps.workspaceRoot, deps.projectSlug);
  } catch (reason) {
    return { registered: false, reason: reason instanceof Error ? reason.message : String(reason) };
  }

  // 2) Sağlayıcılar: hiç kullanılabilir adaptör yoksa motoru başlatmak
  //    her görevi anında hataya sürer.
  const registry = await deps.loadProviders();
  if (registry.providers.size === 0) {
    const detail = registry.skipped
      .map((entry) => `${entry.providerId}(${entry.reason})`)
      .join(', ');
    return {
      registered: false,
      reason: `kullanılabilir sağlayıcı yok${detail === '' ? '' : `: ${detail}`} — panelden API anahtarı girin`,
    };
  }

  // 3) Rol eşlemesi: varsayılana düşmek kullanıcının seçmediği modelle para
  //    harcamaktır (docs/04).
  const routing = await deps.loadRouting();
  let models;
  try {
    models = resolveRuntimeModels(routing);
  } catch (reason) {
    return { registered: false, reason: reason instanceof Error ? reason.message : String(reason) };
  }

  // 4) Birleştirme. Parça kurucuları ayrı modüllerde ve testli; burada
  //    yalnızca bağlanırlar.
  const { createOrchestrationComposition } = await import('./orchestration-assembly.js');
  const assembly = await createOrchestrationComposition({
    ch: deps.ch,
    redis: deps.redis,
    projectId: deps.projectId,
    projectRoot,
    consumerId: deps.consumerId,
    localSessionToken: deps.localSessionToken,
    providers: registry.providers,
    routing,
    models,
  });

  // Kayıt hatası yutulmaz: motor kayıtlı sanılıp çalışmıyor olamaz.
  // bindLate kaydın PARÇASIDIR: ayrı bırakıldığında hiç çağrılmadı ve
  // her görev ilk geçişte 'henüz bağlanmadı' ile düştü.
  deps.register({ composition: assembly.composition, bindLate: assembly.bindLate });

  return {
    registered: true,
    bindLate: assembly.bindLate,
    workerModelRef: models.workerModelRef,
    verifierModelRef: models.verifierModelRef,
    ...(models.warning === undefined ? {} : { warning: models.warning }),
  };
}
