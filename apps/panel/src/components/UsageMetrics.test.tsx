// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ProviderHealthBadges, UsageMetrics } from './UsageMetrics.js';

afterEach(cleanup);

describe('UsageMetrics', () => {
  it('maliyeti dort haneli kurus ile yazar', () => {
    render(<UsageMetrics usage={{
      costUsd: 0.0063, calls: 8, promptTokens: 1000, completionTokens: 500,
    }} />);
    expect(screen.getByText('$0.0063')).toBeDefined();
    expect(screen.getByText('1500')).toBeDefined();
  });

  // Kontör verisi YOKKEN "0" yazmak yalandır: harcama sıfır değil, BİLİNMİYOR.
  it('veri yokken sifir yazmaz', () => {
    render(<UsageMetrics usage={undefined} />);
    expect(screen.queryByText('$0.0000')).toBeNull();
  });
});

describe('ProviderHealthBadges', () => {
  it('durumu TURKCE etiketle gosterir', () => {
    render(<ProviderHealthBadges providers={[
      { provider_id: 'deepseek', health_status: 'down' },
    ]} />);
    expect(screen.getByText(/deepseek/)).toBeDefined();
    expect(screen.getByText(/düştü/)).toBeDefined();
  });

  it('saglayici yoksa hic rozet cizmez', () => {
    const { container } = render(<ProviderHealthBadges providers={[]} />);
    expect(container.querySelector('.provider-health')).toBeNull();
  });
});
