// Emülatör oturumlarının PROJE bağı (docs/10 → "Aynı anda proje başına en çok
// 1 önizleme + 1 emülatör süreci (kaynak koruması)").
//
// NEDEN VAR: mobil önizleme uçları projeden bağımsızdı. İki sonucu vardı:
// docs/10'un proje başına sınırı uygulanamıyordu, ve `events.project_id`
// zorunlu olduğu için yaşam döngüsü olayları hiç yazılamıyordu.

export class MobileSessionError extends Error {}

export class MobileSessionRegistry {
  readonly #byProject = new Map<string, string>();
  readonly #bySession = new Map<string, string>();

  /** Projede zaten açık oturum varsa AÇIK hata verir. */
  assertFree(projectId: string): void {
    const existing = this.#byProject.get(projectId);
    if (existing !== undefined) {
      throw new MobileSessionError(
        `bu projede zaten açık bir emülatör oturumu var: ${existing}`,
      );
    }
  }

  /** Projesiz oturum MEŞRUDUR: panel proje seçmeden de cihaz açabilir. */
  bind(projectId: string | undefined, sessionId: string): void {
    if (projectId === undefined || projectId === '') return;
    this.#byProject.set(projectId, sessionId);
    this.#bySession.set(sessionId, projectId);
  }

  release(sessionId: string): void {
    const projectId = this.#bySession.get(sessionId);
    this.#bySession.delete(sessionId);
    if (projectId !== undefined) this.#byProject.delete(projectId);
  }

  projectOf(sessionId: string): string | undefined {
    return this.#bySession.get(sessionId);
  }
}
