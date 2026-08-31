import { useCallback, useEffect, useState } from 'react';
import { fetchRoleModels, saveRoleModel, type RoleModel } from '../services/role-models.js';

export interface RoleModelDraft {
  modelRef: string;
  fallbackRefs: string;
}

export interface RoleModelsViewModel {
  rows: RoleModel[];
  loading: boolean;
  /** Kullanıcı eyleminin sonucu (kaydetme). */
  status: string;
  /** Liste ALINAMADI; boş listeden ayrı tutulur. */
  loadError: string;
  drafts: Record<string, RoleModelDraft>;
  setDraft: (role: string, draft: RoleModelDraft) => void;
  submit: (role: string) => Promise<void>;
  reload: () => Promise<void>;
}

const asMessage = (reason: unknown): string =>
  reason instanceof Error ? reason.message : String(reason);

const splitRefs = (value: string): string[] =>
  value.split(',').map((ref) => ref.trim()).filter((ref) => ref.length > 0);

export function useRoleModels(): RoleModelsViewModel {
  const [rows, setRows] = useState<RoleModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [drafts, setDrafts] = useState<Record<string, RoleModelDraft>>({});
  // Yükleme hatası, kullanıcı eyleminden doğan `status`tan AYRIDIR.
  const [loadError, setLoadError] = useState('');

  const reload = useCallback(async () => {
    setLoading(true);
    let next: RoleModel[];
    try {
      next = await fetchRoleModels();
    } catch (reason) {
      // Boş tablo "eşleme yok" gibi okunur; yükleme hatası AÇIKÇA söylenir.
      setLoadError(reason instanceof Error ? reason.message : 'Rol eşlemeleri alınamadı');
      setLoading(false);
      return;
    }
    setLoadError('');
    setRows(next);
    // Taslaklar kayıtlı değerle başlar; kullanıcı üzerine yazana dek eşit kalır.
    setDrafts(Object.fromEntries(next.map((row) => [
      row.role,
      { modelRef: row.modelRef, fallbackRefs: row.fallbackRefs.join(', ') },
    ])));
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const setDraft = useCallback((role: string, draft: RoleModelDraft) => {
    setDrafts((current) => ({ ...current, [role]: draft }));
  }, []);

  const submit = useCallback(async (role: string) => {
    const draft = drafts[role];
    if (!draft) return;
    try {
      const saved = await saveRoleModel(role, draft.modelRef, splitRefs(draft.fallbackRefs));
      setRows((current) => current.map((row) => row.role === role ? saved : row));
      setStatus(`${role} → ${saved.modelRef} kaydedildi`);
    } catch (reason) {
      setStatus(asMessage(reason));
    }
  }, [drafts]);

  return { rows, loading, status, loadError, drafts, setDraft, submit, reload };
}
