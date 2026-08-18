// docs/09 View → ViewModel → Service; docs/08 bekleyen sorular kutusu.
import { useCallback, useEffect, useState } from 'react';
import {
  answerQuestion,
  fetchPendingQuestions,
  type PendingQuestion,
} from '../services/questions.js';

export const QUESTIONS_POLL_MS = 10_000;

export interface PendingQuestionsPorts {
  load?: typeof fetchPendingQuestions;
  answer?: typeof answerQuestion;
  pollMs?: number;
}

export function usePendingQuestionsViewModel(
  projectId: string,
  ports: PendingQuestionsPorts = {},
) {
  const load = ports.load ?? fetchPendingQuestions;
  const send = ports.answer ?? answerQuestion;
  const pollMs = ports.pollMs ?? QUESTIONS_POLL_MS;

  const [questions, setQuestions] = useState<PendingQuestion[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback((): void => {
    if (!projectId) return;
    void load(projectId)
      .then((next) => setQuestions(next.messages))
      // Bekleyen soru okunamıyorsa bunu sessizce boş liste gibi göstermek,
      // "soru yok" yalanını söyler.
      .catch((reason: unknown) => setError(
        reason instanceof Error ? reason.message : 'Bekleyen sorular alınamadı'));
  }, [projectId, load]);

  useEffect(() => {
    if (!projectId) return;
    refresh();
    const timer = window.setInterval(refresh, pollMs);
    return () => window.clearInterval(timer);
  }, [projectId, refresh, pollMs]);

  const answer = useCallback(async (messageId: string): Promise<void> => {
    const text = (drafts[messageId] ?? '').trim();
    // Boş cevap göndermek agent'ı bir tur daha boşa çalıştırır.
    if (text === '') { setError('Cevap boş olamaz.'); return; }
    setBusy(true);
    setError('');
    try {
      await send(projectId, messageId, text);
      setDrafts((current) => ({ ...current, [messageId]: '' }));
      refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Cevap gönderilemedi');
    } finally {
      setBusy(false);
    }
  }, [projectId, drafts, send, refresh]);

  return {
    questions,
    error,
    busy,
    draftFor: (messageId: string) => drafts[messageId] ?? '',
    setDraft: (messageId: string, value: string) =>
      setDrafts((current) => ({ ...current, [messageId]: value })),
    answer,
  };
}
