// docs/09 View → ViewModel → Service; docs/08 "düğüme tık → yan panelde
// agent geçmişi".
//
// NEDEN VAR: bu mantık AgentDetail görünümünün İÇİNDEYDİ ve projenin kendi
// standart denetçisi (STD-001) onu ihlal olarak işaretledi: "View katmanında
// durum/yan etki mantığı var". Kendi standardını kendi paneline uygulamayan
// bir denetçi, ürettiği projelere hangi yüzle kural koyacak?
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
    if (agentId === undefined || projectId === '') { setDetail(undefined); return; }
    // `active` bayrağı YARIŞI keser: agent değişince eski isteğin geç gelen
    // cevabı yeni agent'ın verisinin üstüne yazarsa, kullanıcı yanlış
    // agent'ın geçmişini doğru sanar ve denetim baştan bozulur.
    let active = true;
    setError('');
    void load(projectId, agentId)
      .then((next) => { if (active) setDetail(next); })
      .catch((reason: unknown) => {
        // Hata yutulursa boş panel "bu agent hiçbir şey yapmadı" yalanını
        // söyler; oysa veri hiç alınamamıştır.
        if (!active) return;
        setDetail(undefined);
        setError(reason instanceof Error ? reason.message : 'Agent geçmişi alınamadı');
      });
    return () => { active = false; };
  }, [projectId, agentId, load]);

  return { detail, error };
}
