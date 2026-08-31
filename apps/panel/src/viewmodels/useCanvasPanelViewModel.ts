import { useCallback, useState } from "react";

/** Tuvalin sekmeleri. Hash/query ile paylaşılabildiği için tek birlik burada. */
export type CanvasTab = "org" | "tasks" | "gantt" | "council" | "map";

const TABS: readonly CanvasTab[] = ["org", "tasks", "gantt", "council", "map"];

const isTab = (value: string | null): value is CanvasTab =>
  value !== null && (TABS as readonly string[]).includes(value);

/**
 * Açılış sekmesini adres çubuğundan okur. Panel hash router kullandığı için
 * sorgu hem `?tab=` hem `#/...?tab=` biçiminde gelebilir; ikisi de denenir.
 */
export function initialCanvasTab(
  search: string,
  hash: string,
  fallback: CanvasTab = "org",
): CanvasTab {
  try {
    const query = search.startsWith("?")
      ? search
      : hash.includes("?")
        ? hash.slice(hash.indexOf("?"))
        : "";
    const tabParam = new URLSearchParams(query).get("tab");
    return isTab(tabParam) ? tabParam : fallback;
  } catch {
    return fallback;
  }
}

export interface CanvasPanelViewModel {
  readonly activeTab: CanvasTab;
  readonly selectTab: (tab: CanvasTab) => void;
  readonly selectedAgent: string | undefined;
  readonly selectAgent: (agentId: string | undefined) => void;
}

/**
 * Tuval kabuğunun durumu. NEDEN ViewModel: sekme seçimi ve agent seçimi
 * View'da useState olarak duruyordu; docs/09 öz-denetimi bunu STD-001 ile
 * kırmızıya düşürüyordu.
 *
 * `controlledSelectedAgent` verilirse seçim dışarıdan yönetilir; verilmezse
 * yerel seçim kullanılır. İki durumda da `onSelectAgent` bilgilendirilir.
 */
export function useCanvasPanelViewModel({
  controlledSelectedAgent,
  onSelectAgent,
  search = "",
  hash = "",
}: {
  readonly controlledSelectedAgent?: string | undefined;
  readonly onSelectAgent?: ((agentId: string | undefined) => void) | undefined;
  readonly search?: string;
  readonly hash?: string;
} = {}): CanvasPanelViewModel {
  const [activeTab, setActiveTab] = useState<CanvasTab>(() =>
    initialCanvasTab(search, hash),
  );
  const [localSelectedAgent, setLocalSelectedAgent] = useState<string | undefined>(undefined);

  const selectTab = useCallback((tab: CanvasTab) => setActiveTab(tab), []);

  const selectAgent = useCallback(
    (agentId: string | undefined) => {
      setLocalSelectedAgent(agentId);
      onSelectAgent?.(agentId);
    },
    [onSelectAgent],
  );

  return {
    activeTab,
    selectTab,
    selectedAgent: controlledSelectedAgent ?? localSelectedAgent,
    selectAgent,
  };
}
