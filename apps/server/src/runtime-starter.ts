// Motoru açılışta başlatan katman.
//
// `registerPhase9RuntimeConfig` TEK global slot tutar: aynı anda yalnız bir
// projenin runtime'ı kayıtlı olabilir. Bu kısıt gizlenmemeli — hangi projenin
// seçildiği açık kural olmalı, yoksa yanlış projede iş çalıştırılır.
import type { BootstrapResult } from './orchestration-bootstrap.js';

export interface RuntimeProject {
  project_id: string;
  slug: string;
  status: string;
  name: string;
}

export interface StarterDeps {
  enabled: boolean;
  listProjects: () => Promise<readonly RuntimeProject[]>;
  /** WW_RUNTIME_PROJECT_ID ile açıkça seçilen proje. */
  requestedProjectId: string | undefined;
  bootstrap: (project: RuntimeProject) => Promise<BootstrapResult>;
  log: (message: string) => void;
}

export interface StarterResult {
  started: boolean;
  projectId?: string;
  reason?: string;
}

/**
 * Aday proje seçimi. Belirsizlikte SEÇMEZ: birden çok çalışan proje varken
 * sessizce birini almak, yanlış projede para harcatabilir.
 */
export function selectRuntimeProject(
  projects: readonly RuntimeProject[],
  requestedProjectId: string | undefined,
): RuntimeProject | null {
  if (requestedProjectId !== undefined) {
    return projects.find((project) => project.project_id === requestedProjectId) ?? null;
  }
  const running = projects.filter((project) => project.status === 'running');
  return running.length === 1 ? running[0]! : null;
}

export async function startOrchestrationRuntime(deps: StarterDeps): Promise<StarterResult> {
  if (!deps.enabled) {
    return { started: false, reason: 'WW_PHASE8_RUNTIME_ENABLED=1 ayarlı değil' };
  }

  try {
    const projects = await deps.listProjects();
    const project = selectRuntimeProject(projects, deps.requestedProjectId);
    if (project === null) {
      const reason = deps.requestedProjectId === undefined
        ? "tek bir 'running' proje bulunamadı — WW_RUNTIME_PROJECT_ID ile açıkça seçin"
        : `istenen proje bulunamadı: ${deps.requestedProjectId}`;
      deps.log(`[ww] orkestrasyon başlatılamadı: ${reason}`);
      return { started: false, reason };
    }

    const result = await deps.bootstrap(project);
    if (!result.registered) {
      // Kaydedilmediyse motor başlamamıştır; 'started' demek /runtime'ı
      // yalancı yapar.
      deps.log(`[ww] orkestrasyon başlatılamadı: ${result.reason ?? 'bilinmeyen sebep'}`);
      return { started: false, ...(result.reason === undefined ? {} : { reason: result.reason }) };
    }

    if (result.warning !== undefined) deps.log(`[ww] UYARI ${result.warning}`);
    deps.log(
      `[ww] orkestrasyon runtime ETKİN — proje '${project.name}' (${project.slug}), `
      + `worker=${result.workerModelRef ?? '?'} verifier=${result.verifierModelRef ?? '?'}`,
    );
    return { started: true, projectId: project.project_id };
  } catch (reason) {
    // Başlatma hatası sunucuyu düşürmemeli: REST ve panel çalışmaya devam
    // etmeli ki kullanıcı sebebi panelden görebilsin. Ama sessiz de kalmamalı.
    const message = reason instanceof Error ? reason.message : String(reason);
    deps.log(`[ww] orkestrasyon başlatma hatası: ${message}`);
    return { started: false, reason: message };
  }
}
