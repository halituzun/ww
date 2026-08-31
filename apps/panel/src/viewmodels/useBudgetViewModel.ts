// docs/09 → View → ViewModel → Service.
// BudgetPanel yoklama zamanlayıcısını ve fetch'i kendi içinde tutuyordu;
// docs/09 View'da fetch'i yasaklar ve bu mantık aksi halde test edilemez.
import { useEffect, useState } from 'react';
import {
  EMPTY_BUDGET_REPORT,
  fetchBudgetReport,
  setBudgetLimit,
  type BudgetReport,
} from '../services/budget.js';

export const BUDGET_POLL_MS = 10_000;

export interface BudgetViewModelPorts {
  fetchReport?: typeof fetchBudgetReport;
  saveLimit?: typeof setBudgetLimit;
  pollMs?: number;
}

export function useBudgetViewModel(
  projectId: string,
  ports: BudgetViewModelPorts = {},
) {
  const load = ports.fetchReport ?? fetchBudgetReport;
  const save = ports.saveLimit ?? setBudgetLimit;
  const pollMs = ports.pollMs ?? BUDGET_POLL_MS;
  const [report, setReport] = useState<BudgetReport>(EMPTY_BUDGET_REPORT);
  const [limitDraft, setLimitDraft] = useState('');
  const [limitNote, setLimitNote] = useState('');
  const [limitError, setLimitError] = useState('');
  // YÜKLEME hatası KULLANICI hatasından ayrıdır: başarılı bir arka plan
  // yenilemesi, kullanıcının limit doğrulama mesajını silmemeli.
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!projectId) return;
    let active = true;
    const refresh = (): void => {
      void load(projectId)
        .then((next) => { if (active) { setReport(next); setLoadError(''); } })
        .catch((reason: unknown) => {
          // Hata YUTULURSA panel "0 harcandı" der. Para söz konusuyken bu
          // tehlikeli bir yalandır: kullanıcı hiçbir şey çalışmıyor sanır.
          // Veri gelmemesiyle sıfır harcama aynı şey DEĞİLDİR.
          if (active) {
            setLoadError(reason instanceof Error ? reason.message : 'Kontör raporu alınamadı');
          }
        });
    };
    refresh();
    const timer = window.setInterval(refresh, pollMs);
    return () => { active = false; window.clearInterval(timer); };
  }, [projectId, load, pollMs]);

  const saveLimit = async (): Promise<void> => {
    if (!projectId) return;
    const parsed = Number(limitDraft.trim());
    // Boş ya da sayı olmayan girdiyi 0'a (SINIRSIZ) çevirmek, kullanıcının
    // koyduğunu sandığı freni sessizce kaldırırdı.
    if (limitDraft.trim() === '' || !Number.isFinite(parsed)) {
      setLimitError('Bütçe limiti sayı olmalıdır (0 = sınırsız).');
      return;
    }
    setSaving(true);
    setLimitError('');
    setLimitNote('');
    try {
      const result = await save(projectId, parsed);
      setReport(await load(projectId));
      setLimitNote(result.alreadyExceeded
        // Sonucu söylemezsek kullanıcı projenin neden durduğunu aramak
        // zorunda kalır.
        ? `Limit ($${result.limitUsd}) mevcut harcamanın ($${result.spentUsd.toFixed(4)}) altında: proje duracak.`
        : `Limit $${result.limitUsd} olarak kaydedildi.`);
    } catch (reason) {
      setLimitError(reason instanceof Error ? reason.message : 'Bütçe limiti kaydedilemedi');
    } finally {
      setSaving(false);
    }
  };

  return { report, loadError, limitDraft, setLimitDraft, limitNote, limitError, saving, saveLimit };
}
