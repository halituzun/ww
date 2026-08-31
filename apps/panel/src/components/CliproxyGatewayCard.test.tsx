// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { CliproxyGatewayCard } from './CliproxyGatewayCard.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('CliproxyGatewayCard', () => {
  it('gateway bagli degilse kullaniciyi yanlis yonlendirmez', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      state: 'not_configured', baseUrl: 'http://127.0.0.1:8317', managementUrl: 'http://127.0.0.1:8317/management.html', modelCount: null, accountCount: null,
    }), { status: 200 })));
    render(<CliproxyGatewayCard />);
    expect(await screen.findByText('Bağlanmadı')).toBeDefined();
    expect(screen.getByText(/WW_CLIPROXY_ENABLED=1/)).toBeDefined();
  });
});
