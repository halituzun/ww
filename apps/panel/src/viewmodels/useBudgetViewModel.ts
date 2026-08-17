// docs/09 → View → ViewModel → Service.
// BudgetPanel yoklama zamanlayıcısını ve fetch'i kendi içinde tutuyordu;
// docs/09 View'da fetch'i yasaklar ve bu mantık aksi halde test edilemez.
import { useEffect, useState } from 'react';
import {
  EMPTY_BUDGET_REPORT,
  fetchBudgetReport,
  type BudgetReport,
} from '../services/budget.js';

export const BUDGET_POLL_MS = 10_000;

export interface BudgetViewModelPorts {
  fetchReport?: typeof fetchBudgetReport;
  pollMs?: number;
}

export function useBudgetViewModel(
  projectId: string,
  ports: BudgetViewModelPorts = {},
): Readonly<{ report: BudgetReport }> {
  const load = ports.fetchReport ?? fetchBudgetReport;
  const pollMs = ports.pollMs ?? BUDGET_POLL_MS;
  const [report, setReport] = useState<BudgetReport>(EMPTY_BUDGET_REPORT);

  useEffect(() => {
    if (!projectId) return;
    let active = true;
    const refresh = (): void => {
      void load(projectId).then((next) => { if (active) setReport(next); });
    };
    refresh();
    const timer = window.setInterval(refresh, pollMs);
    return () => { active = false; window.clearInterval(timer); };
  }, [projectId, load, pollMs]);

  return { report };
}
