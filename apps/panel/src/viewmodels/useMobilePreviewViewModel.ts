// docs/09 View → ViewModel → Service; docs/10 Android Emülatör.
//
// NEDEN VAR: sunucu uçları hazırdı ama panel onları hiç çağırmıyordu —
// docs/10'un "ekran akışı panelde görünür" maddesi kullanıcı katmanında
// tamamen yoktu.
import { useCallback, useEffect, useState } from 'react';
import {
  fetchMobileFrame, fetchMobileTargets, openMobileSession, stopMobileSession,
  tapMobileSession, type MobileTargets,
} from '../services/mobile.js';

export interface MobilePreviewPorts {
  fetchTargets?: typeof fetchMobileTargets;
  openSession?: typeof openMobileSession;
  fetchFrame?: typeof fetchMobileFrame;
  stopSession?: typeof stopMobileSession;
  tapSession?: typeof tapMobileSession;
  pollMs?: number;
}

const EMPTY: MobileTargets = { avds: [], devices: [] };

/** Kare yenileme aralığı; canlı akış değil, düzenli anlık görüntü. */
export const MOBILE_FRAME_POLL_MS = 2_000;

export function useMobilePreviewViewModel(
  projectId: string | undefined,
  ports: MobilePreviewPorts = {},
) {
  const loadTargets = ports.fetchTargets ?? fetchMobileTargets;
  const open_ = ports.openSession ?? openMobileSession;
  const frame_ = ports.fetchFrame ?? fetchMobileFrame;
  const stop_ = ports.stopSession ?? stopMobileSession;
  const tap_ = ports.tapSession ?? tapMobileSession;
  const pollMs = ports.pollMs ?? MOBILE_FRAME_POLL_MS;

  const [targets, setTargets] = useState<MobileTargets>(EMPTY);
  const [sessionId, setSessionId] = useState('');
  const [frameDataUrl, setFrameDataUrl] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void loadTargets()
      .then((next) => { if (active) { setTargets(next); setError(''); } })
      .catch((reason: unknown) => {
        // Sunucu SEBEBİYLE 503 döner ("Android SDK kurulu mu?"). O sebebi
        // göstermek kullanıcının neyi kuracağını bilmesini sağlar; boş liste
        // göstermek onu karanlıkta bırakır.
        if (active) setError(reason instanceof Error ? reason.message : 'Emülatör hedefleri alınamadı');
      });
    return () => { active = false; };
  }, [loadTargets]);

  const refreshFrame = useCallback(async (id: string) => {
    try {
      const next = await frame_(id);
      setFrameDataUrl(`data:image/png;base64,${next.pngBase64}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Kare alınamadı');
    }
  }, [frame_]);

  useEffect(() => {
    if (sessionId === '') return;
    const timer = window.setInterval(() => { void refreshFrame(sessionId); }, pollMs);
    return () => { window.clearInterval(timer); };
  }, [sessionId, pollMs, refreshFrame]);

  const open = useCallback(async (target?: string) => {
    setBusy(true);
    try {
      const session = await open_(target, projectId);
      setSessionId(session.sessionId);
      setError('');
      await refreshFrame(session.sessionId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Oturum açılamadı');
    } finally {
      setBusy(false);
    }
  }, [open_, refreshFrame, projectId]);

  const stop = useCallback(async () => {
    if (sessionId === '') return;
    setBusy(true);
    try {
      await stop_(sessionId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Oturum durdurulamadı');
    } finally {
      // Kare TEMİZLENİR: eski kareyi göstermeye devam etmek "hâlâ canlı"
      // yalanını söyler.
      setSessionId('');
      setFrameDataUrl('');
      setBusy(false);
    }
  }, [sessionId, stop_]);

  /**
   * Dokunuştan SONRA kare hemen tazelenir: 2 saniyelik yoklamayı beklemek
   * kullanıcıya "dokunuş işe yaramadı" hissi verir.
   */
  const tap = useCallback(async (point: Readonly<{ x: number; y: number }>) => {
    if (sessionId === '') return;
    try {
      await tap_(sessionId, point);
      await refreshFrame(sessionId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Dokunuş gönderilemedi');
    }
  }, [sessionId, tap_, refreshFrame]);

  return { targets, sessionId, frameDataUrl, error, busy, open, stop, tap };
}
