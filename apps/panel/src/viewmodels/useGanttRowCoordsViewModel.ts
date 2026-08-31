import { useEffect, useRef, useState, type RefObject } from "react";
import { measureTaskRows, type RowCoord } from "../services/gantt-measure.js";

export interface GanttRowCoordsViewModel {
  readonly containerRef: RefObject<HTMLDivElement>;
  readonly rowCoords: ReadonlyMap<string, RowCoord>;
}

/**
 * Gantt bağımlılık oklarının ihtiyaç duyduğu satır koordinatları.
 *
 * NEDEN ViewModel: ölçüm durumu (useState) ve yeniden ölçüm kararı
 * (useEffect) View'da duruyordu — docs/09 STD-001. Ölçümün kendisi DOM'a
 * dokunduğu için services/gantt-measure'a taşındı (STD-002).
 *
 * `remeasureKey` değiştiğinde yeniden ölçülür: yerleşim yalnız gruplar ya da
 * toplam süre değiştiğinde kayar.
 */
export function useGanttRowCoordsViewModel(remeasureKey: unknown): GanttRowCoordsViewModel {
  const containerRef = useRef<HTMLDivElement>(null);
  const [rowCoords, setRowCoords] = useState<ReadonlyMap<string, RowCoord>>(() => new Map());

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    setRowCoords(measureTaskRows(container));
  }, [remeasureKey]);

  return { containerRef, rowCoords };
}
