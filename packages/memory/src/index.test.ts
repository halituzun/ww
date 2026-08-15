import { describe, expect, it } from 'vitest';

describe('@ww/memory exports', () => {
  it('temporal snapshot builder paket sinirindan sunulur', async () => {
    expect((await import('./index.js')).TaskContextSnapshotBuilder).toBeTypeOf('function');
  });
});
