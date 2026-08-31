import { useCallback, useEffect, useState } from 'react';
import {
  fetchProviders,
  saveProviderKey,
  upsertProvider,
  type Provider,
  type ProviderConfigInput,
} from '../services/providers.js';

export interface ProviderDraft {
  id: string;
  displayName: string;
  baseUrl: string;
  models: string;
  fallbackOrder: string;
}

export const EMPTY_DRAFT: ProviderDraft = {
  id: '', displayName: '', baseUrl: '', models: '', fallbackOrder: '0',
};

export interface ProvidersViewModel {
  providers: Provider[];
  loading: boolean;
  status: string;
  draft: ProviderDraft;
  keyInputs: Record<string, string>;
  setDraft: (draft: ProviderDraft) => void;
  setKeyInput: (providerId: string, value: string) => void;
  reload: () => Promise<void>;
  submitKey: (providerId: string) => Promise<void>;
  submitDraft: () => Promise<void>;
}

const asMessage = (reason: unknown): string =>
  reason instanceof Error ? reason.message : String(reason);

// Sağlayıcı yönetimi ViewModel'i (MVVM). Ham anahtar yalnız gönderim anına kadar
// yerel input state'inde durur; başarılı kayıttan sonra derhal temizlenir.
export function useProviders(): ProvidersViewModel {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [draft, setDraft] = useState<ProviderDraft>(EMPTY_DRAFT);
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({});

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setProviders(await fetchProviders());
    } catch (reason) {
      setStatus(asMessage(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const setKeyInput = useCallback((providerId: string, value: string) => {
    setKeyInputs((current) => ({ ...current, [providerId]: value }));
  }, []);

  const submitKey = useCallback(async (providerId: string) => {
    const apiKey = keyInputs[providerId] ?? '';
    try {
      const result = await saveProviderKey(providerId, apiKey);
      setKeyInputs((current) => ({ ...current, [providerId]: '' }));
      setProviders((current) => current.map((provider) => provider.provider_id === providerId
        ? { ...provider, keyConfigured: result.configured, maskedKey: result.maskedKey }
        : provider));
      setStatus(`${providerId} anahtarı kaydedildi (${result.maskedKey})`);
    } catch (reason) {
      setStatus(asMessage(reason));
    }
  }, [keyInputs]);

  const submitDraft = useCallback(async () => {
    const input: ProviderConfigInput = {
      providerId: draft.id,
      displayName: draft.displayName,
      baseUrl: draft.baseUrl,
      models: draft.models.split(',').map((model) => model.trim()).filter((model) => model.length > 0),
      enabled: true,
      isDefault: false,
      fallbackOrder: Number.parseInt(draft.fallbackOrder, 10) || 0,
    };
    try {
      const saved = await upsertProvider(input);
      setProviders((current) => [
        ...current.filter((provider) => provider.provider_id !== saved.provider_id),
        saved,
      ]);
      setDraft(EMPTY_DRAFT);
      setStatus(`${saved.display_name} eklendi — şimdi API anahtarını gir.`);
    } catch (reason) {
      setStatus(asMessage(reason));
    }
  }, [draft]);

  return {
    providers, loading, status, draft, keyInputs,
    setDraft, setKeyInput, reload, submitKey, submitDraft,
  };
}
