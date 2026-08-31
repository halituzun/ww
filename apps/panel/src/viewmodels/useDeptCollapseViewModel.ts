import { useCallback, useState } from "react";

export interface DeptCollapseViewModel {
  /**
   * Katlanmış departman kimlikleri. `open-<id>` biçimindeki girdiler
   * "kullanıcı bu departmanı AÇIKÇA açtı" demektir; yerleşim hesabı
   * varsayılan katlama kuralını bu işaretle geçersiz kılar.
   */
  readonly collapsedDepts: ReadonlySet<string>;
  readonly toggleCollapse: (deptId: string) => void;
}

/**
 * Tuvalde departman katlama durumu.
 *
 * NEDEN ViewModel: durum AgentCanvas View'ında useState olarak duruyordu ve
 * docs/09 öz-denetimi bunu STD-001 ile kırmızıya düşürüyordu. Katlama
 * mantığı ayrıca saf: girdi-çıktı olarak test edilebilir olması gerekir.
 */
export function useDeptCollapseViewModel(): DeptCollapseViewModel {
  const [collapsedDepts, setCollapsedDepts] = useState<ReadonlySet<string>>(() => new Set());

  const toggleCollapse = useCallback((deptId: string) => {
    setCollapsedDepts((prev) => toggleDept(prev, deptId));
  }, []);

  return { collapsedDepts, toggleCollapse };
}

/** Saf katlama geçişi — ViewModel dışından da test edilebilsin diye ayrı. */
export function toggleDept(current: ReadonlySet<string>, deptId: string): ReadonlySet<string> {
  const next = new Set(current);
  if (next.has(deptId)) {
    next.delete(deptId);
    next.add(`open-${deptId}`);
  } else {
    next.add(deptId);
    next.delete(`open-${deptId}`);
  }
  return next;
}
