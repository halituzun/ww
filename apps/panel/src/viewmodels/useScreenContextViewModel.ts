// Aktif ekran bağlamı (docs/10 → emre iliştirilen bağlam).
//
// NEDEN VİEWMODEL: bu durum önce App.tsx'te tutuluyordu; kök bileşen de
// görünümdür ve docs/09 View'da durum yasaklar. Denetçinin kök bileşeni
// atlaması bunu gizliyordu — kör nokta kapatılınca ihlal göründü.
import { useCallback, useState } from 'react';
import { commandScreenContext } from './command-context.js';

export function useScreenContextViewModel(tab: string) {
  const [activeUrl, setActiveUrl] = useState('');
  const [activeSession, setActiveSession] = useState('');

  const contextFor = useCallback(
    () => commandScreenContext({
      tab,
      previewUrl: activeUrl,
      mobileSessionId: activeSession,
    }),
    [tab, activeUrl, activeSession],
  );

  return { setActiveUrl, setActiveSession, contextFor };
}
