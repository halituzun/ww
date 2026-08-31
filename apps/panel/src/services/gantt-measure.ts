/**
 * Gantt satırlarının DOM ölçümü.
 *
 * NEDEN services/: docs/09 View'da yan etkiyi (STD-001), ViewModel'de ise
 * doğrudan DOM erişimini (STD-002) yasaklar. Ölçüm gerçek bir DOM adaptörüdür
 * ve IO gibi davranır — yeri bu katmandır. React'e bağımlılığı yoktur.
 */

export interface RowCoord {
  readonly top: number;
  readonly left: number;
  readonly right: number;
  readonly height: number;
}

/** Bağımlılık oklarının bağlanacağı satır koordinatları (kapsayıcıya göreli). */
export function measureTaskRows(container: HTMLElement): ReadonlyMap<string, RowCoord> {
  const coords = new Map<string, RowCoord>();
  const rootRect = container.getBoundingClientRect();

  for (const element of Array.from(
    container.querySelectorAll<HTMLElement>("[data-gantt-task-id]"),
  )) {
    const taskId = element.getAttribute("data-gantt-task-id");
    if (taskId === null || taskId === "") continue;
    const rect = element.getBoundingClientRect();
    coords.set(taskId, {
      top: rect.top - rootRect.top + rect.height / 2,
      left: rect.left - rootRect.left,
      right: rect.right - rootRect.left,
      height: rect.height,
    });
  }

  return coords;
}
