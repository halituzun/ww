import { describe, expect, it, vi } from 'vitest';
import { fetchRoleModels } from './role-models.js';

describe('fetchRoleModels', () => {
  // Boş dizi TABLOYU BOŞ gösterir ve bu "hiç rol eşlemesi yok" gibi okunur.
  // Kullanıcı var olan eşlemeleri yeniden kurmaya yönelir; docs/04
  // varsayılana düşmenin parayla sonuçlandığını söylüyor.
  it('okuma hatasini YUTMAZ', async () => {
    const fetchImpl = vi.fn(async () => new Response('bozuk', { status: 500 }));
    await expect(fetchRoleModels({ fetchImpl: fetchImpl as unknown as typeof fetch }))
      .rejects.toBeTruthy();
  });

  it('basarili yanitta satirlari doner', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify([{ role: 'pm', modelRef: 'deepseek:chat', fallbackRefs: [], configured: true }]),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    await expect(fetchRoleModels({ fetchImpl: fetchImpl as unknown as typeof fetch }))
      .resolves.toHaveLength(1);
  });
});
