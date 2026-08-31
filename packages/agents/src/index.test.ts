import { describe, expect, it } from 'vitest';

describe('@ww/agents public API', () => {
  it('iletisim runtime yuzeyini disari acar', async () => {
    const api = await import('./index.js');
    expect(api).toMatchObject({
      CommunicationService: expect.any(Function),
      PrincipalResolver: expect.any(Function),
      InboxWorker: expect.any(Function),
      EffectRunner: expect.any(Function),
      CommunicationEscalationDelivery: expect.any(Function),
      evaluateCommunicationPolicy: expect.any(Function),
    });
  });
});
