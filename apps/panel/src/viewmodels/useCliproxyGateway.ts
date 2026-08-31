import { useCallback, useEffect, useState } from 'react';
import { fetchCliproxyStatus, type CliproxyGatewayStatus } from '../services/cliproxy.js';

export function useCliproxyGateway() {
  const [status, setStatus] = useState<CliproxyGatewayStatus | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setLoading(true);
    try { setStatus(await fetchCliproxyStatus()); setError(''); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  return { status, error, loading, reload };
}
