// docs/09 View → ViewModel → Service; docs/08 bekleyen sorular kutusu.
import { useCallback, useEffect, useState } from 'react';
import {
  answerQuestion,
  fetchAnswers,
  fetchPendingQuestions,
  type PendingQuestion,
} from '../services/questions.js';

export const QUESTIONS_POLL_MS = 10_000;

export interface PendingQuestionsPorts {
  load?: typeof fetchPendingQuestions;
  answer?: typeof answerQuestion;
  loadAnswers?: typeof fetchAnswers;
  pollMs?: number;
}

export function usePendingQuestionsViewModel(
  projectId: string,
  ports: PendingQuestionsPorts = {},
) {
  const load = ports.load ?? fetchPendingQuestions;
  const send = ports.answer ?? answerQuestion;
  const readAnswers = ports.loadAnswers ?? fetchAnswers;
  const pollMs = ports.pollMs ?? QUESTIONS_POLL_MS;

  const [questions, setQuestions] = useState<PendingQuestion[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Cevaplanan sorunun KAYDEDİLMİŞ hâli. Bu oturumda cevapların hiçbir yere
  // ulaşmadığı bir kusur vardı; "gönderdim" demek yetmez, kaydın okunması
  // gerekir.
  const [confirmed, setConfirmed] = useState<Record<string, string>>({});

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
      // YAZDIKTAN SONRA OKU: cevabın gerçekten kaydedildiğini kanıtlar.
      try {
        const stored = await readAnswers(projectId, messageId);
        const last = stored.answers[stored.answers.length - 1];
        if (last !== undefined) {
          setConfirmed((current) => ({ ...current, [messageId]: last.text }));
        }
      } catch {
        // Doğrulama okuması düşerse cevabı gönderilmemiş SAYMAYIZ; yalnızca
        // onay gösterilmez.
      }
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
    confirmedFor: (messageId: string) => confirmed[messageId],
    draftFor: (messageId: string) => drafts[messageId] ?? '',
    setDraft: (messageId: string, value: string) =>
      setDrafts((current) => ({ ...current, [messageId]: value })),
    answer,
  };
}
