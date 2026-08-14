import { useEffect, useState } from 'react';
import type { HealthReport } from '@ww/shared';
import { fetchHealth } from '../services/health.js';

export type HealthState = 'loading' | 'ok' | 'error';

export interface HealthViewModel {
  health: HealthReport | null;
  state: HealthState;
  status: string;
}

export function useHealth(): HealthViewModel {
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [requestFailed, setRequestFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    void fetchHealth({ signal: controller.signal })
      .then((report) => {
        setHealth(report);
        setRequestFailed(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) setRequestFailed(true);
      });

    return () => controller.abort();
  }, []);

  if (requestFailed) return { health, state: 'error', status: 'Sunucuya ulaşılamıyor' };
  if (!health) return { health: null, state: 'loading', status: 'Kontrol ediliyor' };
  if (!health.ok) return { health, state: 'error', status: 'Servis sorunu' };
  return { health, state: 'ok', status: 'Sistem hazır' };
}
