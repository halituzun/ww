// docs/01 Çökme Kurtarma madde 3: "Working tree'de commit'lenmemiş değişiklik
// varsa `git checkout .` ile temizler (yarım iş kuralı)."
//
// NEDEN VAR: HİÇBİR üretim kodu bunu yapmıyordu. Çökme sonrası yarım yazılmış
// dosyalar diskte kalıyor ve sonraki deneme KİRLİ ağaçtan başlıyordu: worker
// yarım dosyayı okuyabiliyor, kapı bayat içerikle koşuyor ve commit önceki
// başarısız denemeden artık taşıyabiliyordu.

export interface RecoveredProject {
  readonly projectId: string;
  readonly requeuedTaskIds: readonly string[];
}

export interface WorkspaceRecoveryPorts {
  readonly results: readonly RecoveredProject[];
  readonly loadProject: (projectId: string) => Promise<{ readonly slug: string } | null>;
  readonly reset: (projectId: string, slug: string) => Promise<void>;
  readonly onError: (reason: unknown) => void;
}

export async function resetRecoveredWorkspaces(ports: WorkspaceRecoveryPorts): Promise<void> {
  for (const result of ports.results) {
    // HİÇBİR ŞEY kurtarılmadıysa dokunulmaz: çalışan bir sistemin working
    // tree'sini temizlemek, SÜREN işi silmek olurdu.
    if (result.requeuedTaskIds.length === 0) continue;
    try {
      const project = await ports.loadProject(result.projectId);
      if (project === null) continue;
      await ports.reset(result.projectId, project.slug);
    } catch (reason) {
      // Temizlik hatası KURTARMAYI düşürmez: görevler zaten kuyruğa alındı.
      ports.onError(reason);
    }
  }
}
