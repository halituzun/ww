// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PendingQuestions } from './PendingQuestions.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const respond = (body: unknown, ok = true, status = 200) => ({
  ok, status,
  headers: new Headers({ 'content-type': 'application/json' }),
  text: async () => JSON.stringify(body),
});

const pending = {
  recipientId: 'pm', count: 1,
  messages: [{
    messageId: 'm1', kind: 'question', taskId: '8248aa61-b756-47b3-8c19-5858dc1ecadd',
    payload: { text: 'src/Board.tsx var mı?' }, createdAt: '2026-08-18T00:00:00.000Z',
  }],
};

describe('PendingQuestions', () => {
  it('soru yoksa bunu acikca soyler', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      respond({ recipientId: 'pm', count: 0, messages: [] }) as never);
    render(<PendingQuestions projectId="p1" />);
    await waitFor(() => expect(screen.getByText(/bekleyen soru yok/i)).toBeDefined());
  });

  // docs/08: kullanıcı PM'i beklemeden soruyu GÖRÜP cevaplayabilir.
  it('bekleyen soruyu metniyle gosterir', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond(pending) as never);
    render(<PendingQuestions projectId="p1" />);
    await waitFor(() => expect(screen.getByText('src/Board.tsx var mı?')).toBeDefined());
  });

  it('cevabi gonderir', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValue(respond(pending) as never);
    render(<PendingQuestions projectId="p1" />);
    await waitFor(() => expect(screen.getByText('src/Board.tsx var mı?')).toBeDefined());

    fireEvent.change(screen.getByLabelText('Cevap m1'), { target: { value: 'yok, oluştur' } });
    fireEvent.click(screen.getByText('Cevapla'));

    await waitFor(() => {
      const posted = fetchMock.mock.calls.find(([, init]) =>
        (init as RequestInit | undefined)?.method === 'POST');
      expect(posted).toBeDefined();
      expect(String((posted![1] as RequestInit).body)).toContain('yok, oluştur');
    });
  });

  // Boş cevap göndermek agent'ı bir tur daha boşa çalıştırır.
  it('bos cevabi gondermez', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValue(respond(pending) as never);
    render(<PendingQuestions projectId="p1" />);
    await waitFor(() => expect(screen.getByText('src/Board.tsx var mı?')).toBeDefined());

    fireEvent.click(screen.getByText('Cevapla'));

    await waitFor(() => expect(screen.getByText(/cevap boş olamaz/i)).toBeDefined());
    expect(fetchMock.mock.calls.some(([, init]) =>
      (init as RequestInit | undefined)?.method === 'POST')).toBe(false);
  });

  // Sessizce boş liste göstermek "soru yok" yalanını söyler.
  it('okuma hatasini gizlemez', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      respond({ message: 'PM yok' }, false, 400) as never);
    render(<PendingQuestions projectId="p1" />);
    await waitFor(() => expect(screen.getByText(/PM yok|Bekleyen sorular alınamadı/)).toBeDefined());
  });
});

describe('PendingQuestions — cevap doğrulaması', () => {
  // Bu oturumda cevapların hiçbir yere ulaşmadığı bir kusur vardı:
  // "gönderdim" demek yetmez, kaydın OKUNMASI gerekir.
  it('gonderdikten sonra kaydedilen cevabi okuyup gosterir', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const target = String(url);
      if ((init as RequestInit | undefined)?.method === 'POST') return respond({ messageId: 'a1' }) as never;
      if (target.includes('/answers')) {
        return respond({
          replyToMessageId: 'm1', count: 1,
          answers: [{ messageId: 'a1', senderPrincipalId: 'u', createdAt: 'x', text: 'yok, oluştur' }],
        }) as never;
      }
      return respond(pending) as never;
    });

    render(<PendingQuestions projectId="p1" />);
    await waitFor(() => expect(screen.getByText('src/Board.tsx var mı?')).toBeDefined());

    fireEvent.change(screen.getByLabelText('Cevap m1'), { target: { value: 'yok, oluştur' } });
    fireEvent.click(screen.getByText('Cevapla'));

    await waitFor(() => expect(screen.getByText(/Kaydedilen cevap: yok, oluştur/)).toBeDefined());
  });

  // Doğrulama okuması düşerse cevabı gönderilmemiş SAYMAYIZ.
  it('dogrulama okumasi dusunce cevabi basarisiz saymaz', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if ((init as RequestInit | undefined)?.method === 'POST') return respond({ messageId: 'a1' }) as never;
      if (String(url).includes('/answers')) return respond({ message: 'yok' }, false, 500) as never;
      return respond(pending) as never;
    });

    render(<PendingQuestions projectId="p1" />);
    await waitFor(() => expect(screen.getByText('src/Board.tsx var mı?')).toBeDefined());

    fireEvent.change(screen.getByLabelText('Cevap m1'), { target: { value: 'cevap' } });
    fireEvent.click(screen.getByText('Cevapla'));

    await waitFor(() => expect(screen.queryByText(/Cevap gönderilemedi/)).toBeNull());
  });
});
