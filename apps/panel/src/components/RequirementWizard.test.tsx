// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RequirementWizard } from './RequirementWizard.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const respond = (body: unknown, ok = true, status = 200) => ({
  ok, status,
  headers: new Headers({ 'content-type': 'application/json' }),
  text: async () => JSON.stringify(body),
});

const questions = {
  questions: [
    { id: 'goal', prompt: 'Bu projenin ana hedefi nedir?', required: true },
    { id: 'constraints', prompt: 'Kısıt var mı?', required: false },
  ],
};

describe('RequirementWizard', () => {
  it('proje secilmediginde yonlendirir', () => {
    render(<RequirementWizard projectId="" />);
    expect(screen.getByText(/önce bir proje seçin/i)).toBeDefined();
  });

  it('sorulari listeler', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond(questions) as never);
    render(<RequirementWizard projectId="p1" />);
    await waitFor(() => expect(screen.getByText(/ana hedefi nedir\?\s?\*/)).toBeDefined());
  });

  // Zorunlu soru boşken göndermek sunucuda reddedilir; sebebi BURADA
  // söylemek, anlaşılmayan bir hatadan iyidir.
  it('zorunlu soru bosken gondermez', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond(questions) as never);
    render(<RequirementWizard projectId="p1" />);
    await waitFor(() => expect(screen.getByText(/ana hedefi nedir/)).toBeDefined());

    fireEvent.click(screen.getByText('Gereksinimleri kaydet'));

    await waitFor(() => expect(screen.getByText(/Zorunlu sorular cevaplanmadı/)).toBeDefined());
    expect(fetchMock.mock.calls.some(([, init]) =>
      (init as RequestInit | undefined)?.method === 'POST')).toBe(false);
  });

  // Kaydedildiği söylenmezse kullanıcı aynı cevapları tekrar yazar.
  it('kaydedince bunu bildirir', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) =>
      ((init as RequestInit | undefined)?.method === 'POST'
        ? respond({ sessionId: 's', complete: true, knowledgeId: 'k', requirement: '#' })
        : respond(questions)) as never);

    render(<RequirementWizard projectId="p1" />);
    await waitFor(() => expect(screen.getByText(/ana hedefi nedir/)).toBeDefined());

    fireEvent.change(screen.getByLabelText('Bu projenin ana hedefi nedir?'),
      { target: { value: 'Todo uygulaması' } });
    fireEvent.click(screen.getByText('Gereksinimleri kaydet'));

    await waitFor(() => expect(screen.getByText(/Gereksinimler kaydedildi/)).toBeDefined());
  });

  // ZİNCİRİN MÜHÜRÜ: gereksinim yazıldıktan sonra konsey KENDİLİĞİNDEN koşar.
  // Önceden panelde POST /council çağıran hiçbir kod yoktu; konsey ancak
  // elle `curl` ile başlatılabiliyordu (docs/11 Faz 4 zinciri kopuktu).
  it('gereksinim kaydedilince konseyi kendiliginden baslatir', async () => {
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const method = (init as RequestInit | undefined)?.method ?? 'GET';
      if (method === 'POST') calls.push(String(url));
      if (String(url).endsWith('/interview')) {
        return (method === 'POST'
          ? respond({ sessionId: 's', complete: true, knowledgeId: 'k', requirement: '# gereksinim' })
          : respond(questions)) as never;
      }
      return respond({ planId: 'plan-1' }) as never;
    });

    render(<RequirementWizard projectId="p1" />);
    await waitFor(() => expect(screen.getByText(/ana hedefi nedir/)).toBeDefined());
    fireEvent.change(screen.getByLabelText('Bu projenin ana hedefi nedir?'),
      { target: { value: 'Todo uygulaması' } });
    fireEvent.click(screen.getByText('Gereksinimleri kaydet'));

    await waitFor(() => expect(screen.getByText(/Konsey planı hazır/)).toBeDefined());
    expect(calls.some((url) => url.endsWith('/council'))).toBe(true);
  });

  // Konsey hatası, gereksinimin KAYDEDİLDİĞİ gerçeğini geçersiz kılmaz.
  it('konsey duserse gereksinimin kaydedildigini yine soyler', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const method = (init as RequestInit | undefined)?.method ?? 'GET';
      if (String(url).endsWith('/interview')) {
        return (method === 'POST'
          ? respond({ sessionId: 's', complete: true, knowledgeId: 'k', requirement: '#' })
          : respond(questions)) as never;
      }
      return respond({ message: 'konsey icin en az 3 uye gerekir' }, false, 400) as never;
    });

    render(<RequirementWizard projectId="p1" />);
    await waitFor(() => expect(screen.getByText(/ana hedefi nedir/)).toBeDefined());
    fireEvent.change(screen.getByLabelText('Bu projenin ana hedefi nedir?'),
      { target: { value: 'Todo uygulaması' } });
    fireEvent.click(screen.getByText('Gereksinimleri kaydet'));

    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined());
    expect(screen.getByRole('alert').textContent).toMatch(/konsey başlatılamadı/i);
    // "Gereksinimler kaydedildi" ipucu hem ipuçta hem hata metninde geçer;
    // ikisinin de görünmesi beklenen davranıştır.
    expect(screen.getAllByText(/Gereksinimler kaydedildi/).length).toBeGreaterThan(0);
  });
});
