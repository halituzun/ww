import { useMemo } from "react";
import type { Task } from "../services/projects.js";
import type { OrgPlan } from "@ww/shared";
import { taskStatusLabel, cleanRoleName } from "../services/labels.js";

export interface GanttTaskItem {
  readonly taskId: string;
  readonly title: string;
  readonly departmentId: string;
  readonly departmentName: string;
  readonly assignedRole: string;
  readonly assignedModel: string;
  readonly status: string;
  readonly statusLabel: string;
  readonly startMin: number;
  readonly durationMin: number;
  readonly endMin: number;
  readonly progressPct: number;
  readonly isRunning: boolean;
  readonly isQueued: boolean;
  readonly dependsOn: readonly string[];
}

export interface GanttDepartmentGroup {
  readonly id: string;
  readonly name: string;
  readonly tasks: readonly GanttTaskItem[];
}

export interface GanttViewModelResult {
  readonly groups: readonly GanttDepartmentGroup[];
  readonly totalMinutes: number;
  readonly currentMinute: number;
  readonly taskMap: ReadonlyMap<string, GanttTaskItem>;
}

export function useGanttViewModel(tasks: readonly Task[], orgPlan?: OrgPlan): GanttViewModelResult {
  return useMemo(() => {
    const defaultDepts = orgPlan?.departments || [
      { id: "dept-ui", name: "Kullanıcı Arayüzü & Sunum", responsibility_patterns: ["src/views/**", "src/styles/**"] },
      { id: "dept-core", name: "Zamanlayıcı & Çekirdek Motor", responsibility_patterns: ["src/timer.js", "src/state.js"] },
    ];

    const taskMap = new Map<string, GanttTaskItem>();
    const deptTaskBuckets = new Map<string, GanttTaskItem[]>();

    defaultDepts.forEach((d) => deptTaskBuckets.set(d.id, []));
    const fallbackBucket: GanttTaskItem[] = [];

    // Zaman ekseni hesaplamaları (dakika cinsinden)
    let maxTimelineMin = 35; // varsayılan en az 35 dk pencere
    const nowMin = 18; // örnek aktif canlı zaman çizgisi

    tasks.forEach((task, idx) => {
      const isDone = task.status === "done";
      const isRunning = task.status === "working" || task.status === "verifying" || task.status === "testing";
      const isQueued = task.status === "queued" || task.status === "blocked" || !task.status;

      // Departman tespiti (hedef dosyalara veya sıraya göre)
      let dept = defaultDepts.find((d) =>
        d.responsibility_patterns?.some((p) => task.title?.toLowerCase().includes("stil") || task.title?.toLowerCase().includes("arayüz"))
      );
      if (!dept) {
        dept = defaultDepts[idx % defaultDepts.length] || defaultDepts[0];
      }

      const startMin = isQueued ? Math.max(nowMin, idx * 8) : Math.max(0, idx * 8);
      const durationMin = isRunning ? Math.max(6, nowMin - startMin) : (isDone ? 10 : 8);
      const endMin = startMin + durationMin;
      if (endMin > maxTimelineMin) maxTimelineMin = endMin + 8;

      const progressPct = isDone ? 100 : (isRunning ? Math.min(85, Math.round(((nowMin - startMin) / durationMin) * 100)) : 0);

      const assignedRole = idx % 2 === 0 ? "Yapan" : "Denetleyen";
      const assignedModel = idx % 2 === 0 ? "deepseek-coder" : "qwen3.6";

      const item: GanttTaskItem = {
        taskId: task.task_id,
        title: task.title || `Görev ${idx + 1}`,
        departmentId: dept ? dept.id : "dept-default",
        departmentName: dept ? dept.name : "Genel İcra",
        assignedRole,
        assignedModel,
        status: task.status,
        statusLabel: isQueued ? "Kuyrukta (Başlamadı)" : taskStatusLabel(task.status),
        startMin,
        durationMin,
        endMin,
        progressPct,
        isRunning,
        isQueued,
        dependsOn: (task.depends_on as readonly string[]) || [],
      };

      taskMap.set(task.task_id, item);
      if (dept && deptTaskBuckets.has(dept.id)) {
        deptTaskBuckets.get(dept.id)!.push(item);
      } else {
        fallbackBucket.push(item);
      }
    });

    const groups: GanttDepartmentGroup[] = [];
    defaultDepts.forEach((d) => {
      const items = deptTaskBuckets.get(d.id) || [];
      if (items.length > 0) {
        groups.push({ id: d.id, name: d.name, tasks: items });
      }
    });

    if (fallbackBucket.length > 0) {
      groups.push({ id: "dept-other", name: "Diğer Görevler", tasks: fallbackBucket });
    }

    // Eksen genişliği en az 35 dk veya içeriğe göre 5'in katı
    const calculatedTotal = Math.max(35, Math.ceil((Math.max(nowMin + 10, maxTimelineMin)) / 5) * 5);

    return {
      groups,
      totalMinutes: calculatedTotal,
      currentMinute: nowMin,
      taskMap,
    };
  }, [tasks, orgPlan]);
}
