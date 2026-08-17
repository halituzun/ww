// @vitest-environment jsdom
//
// NEDEN VAR: App.tsx bir ViewModel refactor'ünden geçti ve panelde hiçbir
// çizim testi yoktu. Tipler doğru olsa bile eksik bir alan ya da kopmuş bir
// prop ancak tarayıcıda patlar — yani kullanıcıda. Bu test, ekranın gerçekten
// çizildiğini ve View'ın ViewModel'den beklediği her şeyi aldığını kanıtlar.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import App from './App.js';

const emptyResponse = (): Response => ({
  ok: true,
  status: 200,
  headers: new Headers({ 'content-type': 'application/json' }),
  json: async () => [],
  text: async () => '[]',
}) as Response;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => emptyResponse()));
  // WebSocket'i sahtelemezsek jsdom gerçek bağlantı açmayı dener.
  vi.stubGlobal('WebSocket', class {
    close(): void { /* test soketi */ }
    send(): void { /* test soketi */ }
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('App', () => {
  it('çalışma alanı ekranını çizer', () => {
    render(<App />);
    expect(screen.getByText('Agent çalışma alanı')).toBeDefined();
  });

  // Bağlantı durumu görünmezse kopan besleme yine sessizce ölür.
  it('canlı bağlantı durumunu gösterir', () => {
    render(<App />);
    expect(screen.getByTitle('Canlı olay bağlantısı')).toBeDefined();
  });

  it('proje kimliği girişini sunar', () => {
    render(<App />);
    expect(screen.getByLabelText('Proje kimliği')).toBeDefined();
  });

  // Projesiz açılışta bile ekran çökmemeli: ilk kullanıcı deneyimi budur.
  it('proje seçilmemişken hata vermeden çizilir', () => {
    expect(() => render(<App />)).not.toThrow();
  });

  it('sağlayıcılar sayfasına geçiş düğmesi bulunur', () => {
    render(<App />);
    expect(screen.getByRole('button', { name: "API'ler" })).toBeDefined();
  });
});
