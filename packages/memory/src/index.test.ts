import { describe, expect, it } from 'vitest';

describe('@ww/memory scaffold', () => {
  it('paket sınırı yüklenir', async () => {
    expect(Object.keys(await import('./index.js'))).toEqual([]);
  });
});
