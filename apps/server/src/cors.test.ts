import { describe, expect, it } from 'vitest';
import { panelOrigins } from './cors.js';

describe('panelOrigins', () => {
  it('yerel panel originlerini varsayılan olarak sınırlar', () => {
    expect(panelOrigins('')).toEqual([
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:3001',
      'http://127.0.0.1:3001',
      'http://localhost:3000',
      'http://127.0.0.1:3000',
    ]);
  });

  it('originleri URL.origin ile normalize edip tekilleştirir', () => {
    expect(panelOrigins('https://panel.example/, https://panel.example:443'))
      .toEqual(['https://panel.example']);
  });

  it.each([
    'https://user:pass@panel.example',
    'https://panel.example/app',
    'https://panel.example?preview=1',
    'ftp://panel.example',
    'not-a-url',
  ])('güvensiz veya origin olmayan %s değerini reddeder', (value) => {
    expect(() => panelOrigins(value)).toThrow(/origin/);
  });
});
