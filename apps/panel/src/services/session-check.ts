import { apiUrl, type RequestOptions } from './http.js';

/**
 * Aday oturum token'ının geçerliliği.
 *
 * NEDEN AYRI SERVİS: bu istek `http.ts`'in genel yolundan geçemez — o yol
 * YAPILANDIRILMIŞ token'ı kullanır, oysa burada kullanıcının HENÜZ
 * kaydetmediği aday token denenir. Yine de IO'dur ve docs/09 gereği yeri
 * services katmanıdır; eskiden useSettingsViewModel içinde çıplak `fetch`
 * ile duruyordu ve öz-denetim ViewModel'de `fetch`'i ihlal saymadığı için
 * hiç yakalanmıyordu.
 */
export type SessionTokenCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'unauthorized' | 'unreachable' | 'server'; readonly status?: number };

export async function checkSessionToken(
  candidateToken: string,
  options: RequestOptions = {},
): Promise<SessionTokenCheck> {
  const token = candidateToken.trim().startsWith('Bearer ')
    ? candidateToken.trim().slice(7).trim()
    : candidateToken.trim();
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(apiUrl(options.baseUrl, '/projects'), {
      headers: { authorization: `Bearer ${token}` },
    });
    if (response.ok) return { ok: true };
    if (response.status === 401) return { ok: false, reason: 'unauthorized', status: 401 };
    return { ok: false, reason: 'server', status: response.status };
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}
