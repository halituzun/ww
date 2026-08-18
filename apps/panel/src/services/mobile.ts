// Emülatör önizleme servisi (docs/10 → Android Emülatör).
//
// NEDEN VAR: sunucu uçları vardı ama PANEL onları hiç çağırmıyordu; docs/10'un
// "ekran akışı panelde görünür" maddesi ve docs/11 Faz 6'nın kabul adımı
// kullanıcı katmanında hiç yoktu.
import { getJson, requestJson, type RequestOptions } from './http.js';

export interface MobileTargets {
  avds: string[];
  devices: string[];
}

export interface MobileSession {
  sessionId: string;
  avd: string;
}

export interface MobileFrame {
  sessionId: string;
  pngBase64: string;
}

/**
 * HATAYI YUTMAZ: hedef bulunamadığında sunucu SEBEBİYLE 503 döner ("emülatör
 * araçları kurulu mu?"). Boş listeye düşmek o sebebi yok eder ve panel
 * "hiçbir şey yok" der — kullanıcı neyi kuracağını bilemez.
 */
export const fetchMobileTargets = (options: RequestOptions = {}): Promise<MobileTargets> =>
  getJson<MobileTargets>('/mobile-preview/avds', options);

export const openMobileSession = (
  target: string | undefined,
  options: RequestOptions = {},
): Promise<MobileSession> =>
  requestJson<MobileSession>('/mobile-preview/sessions', {
    ...options,
    method: 'POST',
    body: target === undefined ? {} : { avd: target },
  });

export const fetchMobileFrame = (
  sessionId: string,
  options: RequestOptions = {},
): Promise<MobileFrame> =>
  getJson<MobileFrame>(
    `/mobile-preview/sessions/${encodeURIComponent(sessionId)}/frame`,
    options,
  );

export const stopMobileSession = (
  sessionId: string,
  options: RequestOptions = {},
): Promise<{ stopped: string }> =>
  requestJson<{ stopped: string }>(
    `/mobile-preview/sessions/${encodeURIComponent(sessionId)}`,
    { ...options, method: 'DELETE' },
  );

export const tapMobileSession = (
  sessionId: string,
  point: Readonly<{ x: number; y: number }>,
  options: RequestOptions = {},
): Promise<{ sessionId: string; x: number; y: number }> =>
  requestJson<{ sessionId: string; x: number; y: number }>(
    `/mobile-preview/sessions/${encodeURIComponent(sessionId)}/tap`,
    { ...options, method: 'POST', body: point },
  );
