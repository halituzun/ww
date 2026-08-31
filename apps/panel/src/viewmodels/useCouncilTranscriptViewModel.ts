import { useCallback, useEffect, useState } from "react";
import { fetchPlans } from "../services/plans.js";
import {
  fetchCouncilDecisions,
  requestCouncilRound,
  type CouncilDecision,
} from "../services/council.js";

export type CouncilView = "rounds" | "decisions";

export interface CouncilTranscriptViewModel {
  readonly activeRound: number;
  readonly selectRound: (round: number) => void;
  readonly activeView: CouncilView;
  readonly selectView: (view: CouncilView) => void;
  /** Plan içeriği dışarıdan gelmediyse uçtan çekilen markdown. */
  readonly fetchedContentMd: string | undefined;
  readonly decisions: readonly CouncilDecision[];
  readonly additionalTopic: string;
  readonly setAdditionalTopic: (topic: string) => void;
  readonly requestingRound: boolean;
  readonly roundFeedback: string | null;
  readonly submitRound: () => Promise<void>;
}

/**
 * Konsey dökümü ekranının durumu ve veri erişimi.
 *
 * NEDEN ViewModel: View'da yedi ayrı useState, bir useEffect ve iki çıplak
 * `fetch` vardı; öz-denetim bunu STD-001 ile iki kez kırmızıya düşürüyordu.
 */
export function useCouncilTranscriptViewModel({
  projectId,
  hasInitialContent,
}: {
  readonly projectId: string | undefined;
  readonly hasInitialContent: boolean;
}): CouncilTranscriptViewModel {
  const [activeRound, setActiveRound] = useState(1);
  const [activeView, setActiveView] = useState<CouncilView>("rounds");
  const [fetchedContentMd, setFetchedContentMd] = useState<string | undefined>(undefined);
  const [decisions, setDecisions] = useState<readonly CouncilDecision[]>([]);
  const [additionalTopic, setAdditionalTopic] = useState("");
  const [requestingRound, setRequestingRound] = useState(false);
  const [roundFeedback, setRoundFeedback] = useState<string | null>(null);

  useEffect(() => {
    if (projectId === undefined || projectId === "") return;
    let cancelled = false;

    if (!hasInitialContent) {
      void fetchPlans(projectId)
        .then((plans) => {
          const contentMd = plans[0]?.content_md;
          if (!cancelled && contentMd !== undefined && contentMd !== "") {
            setFetchedContentMd(contentMd);
          }
        })
        .catch(() => {
          // Plan yoksa döküm de yoktur; View zaten boş durum gösterir.
        });
    }

    void fetchCouncilDecisions(projectId)
      .then((rows) => {
        if (!cancelled && rows.length > 0) setDecisions(rows);
      })
      .catch(() => {
        // Karar defteri boş kalır. UYARI: burada hata yutuluyor; bunu
        // görünür kılmak Faz D5'in (bağlam/veri hatası sessiz kalmasın)
        // kapsamındadır.
      });

    return () => {
      cancelled = true;
    };
  }, [projectId, hasInitialContent]);

  const submitRound = useCallback(async () => {
    const topic = additionalTopic.trim();
    if (topic === "" || projectId === undefined || projectId === "") return;
    setRequestingRound(true);
    setRoundFeedback(null);
    try {
      await requestCouncilRound(projectId, topic);
      setRoundFeedback("Ek müzakere turu başarıyla başlatıldı.");
      setAdditionalTopic("");
    } catch (reason) {
      setRoundFeedback(reason instanceof Error ? `Hata: ${reason.message}` : "Ek tur açılamadı");
    } finally {
      setRequestingRound(false);
    }
  }, [additionalTopic, projectId]);

  return {
    activeRound,
    selectRound: setActiveRound,
    activeView,
    selectView: setActiveView,
    fetchedContentMd,
    decisions,
    additionalTopic,
    setAdditionalTopic,
    requestingRound,
    roundFeedback,
    submitRound,
  };
}
