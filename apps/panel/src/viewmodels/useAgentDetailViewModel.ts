import { useEffect, useState } from 'react';
import { fetchAgentDetail, type AgentDetail } from '../services/canvas.js';

export interface AgentDetailViewModelPorts {
  load?: typeof fetchAgentDetail;
}

export function useAgentDetailViewModel(
  projectId: string,
  agentId: string | undefined,
  ports: AgentDetailViewModelPorts = {},
) {
  const load = ports.load ?? fetchAgentDetail;
  const [detail, setDetail] = useState<AgentDetail | undefined>();
  const [error, setError] = useState('');

  useEffect(() => {
    if (!agentId || !projectId) {
      setDetail(undefined);
      setError('');
      return;
    }
    let active = true;
    setError('');
    void load(projectId, agentId)
      .then((next) => { if (active) setDetail(next); })
      .catch((reason: unknown) => {
        if (!active) return;
        setDetail(undefined);
        setError(reason instanceof Error ? reason.message : 'Agent geçmişi alınamadı');
      });
    return () => { active = false; };
  }, [projectId, agentId, load]);

  return { detail, error };
}
