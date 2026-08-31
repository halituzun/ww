/**
 * API konsolunun ham isteği.
 *
 * NEDEN AYRI SERVİS: konsol, KULLANICININ yazdığı bir URL'e istek atar —
 * projenin kendi API'sine değil. Bu yüzden `http.ts`'in oturum başlıklı
 * yolundan geçmez; ama yine de IO'dur ve docs/09 gereği yeri services
 * katmanıdır. Eskiden useApiConsoleViewModel içinde çıplak `fetch` ile
 * duruyordu ve öz-denetim ViewModel'de `fetch`'i ihlal saymadığı için hiç
 * yakalanmıyordu.
 */
export interface ApiConsoleResponse {
  readonly status: number;
  readonly text: string;
}

export async function sendApiConsoleRequest(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ApiConsoleResponse> {
  const response = await fetchImpl(url);
  return { status: response.status, text: await response.text() };
}
