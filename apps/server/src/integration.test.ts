import { describe, expect, it } from 'vitest';
import { integrationRequired, parseIntegrationRequired } from './integration.js';

describe('parseIntegrationRequired', () => {
  it.each([undefined, '', '0', 'false', ' FALSE '])('%s için opt-in kapalıdır', (value) => {
    expect(parseIntegrationRequired(value)).toBe(false);
  });

  it.each(['1', 'true', ' TRUE '])('%s için opt-in açıktır', (value) => {
    expect(parseIntegrationRequired(value)).toBe(true);
  });

  it('geçersiz değeri yapılandırma hatası olarak reddeder', () => {
    expect(() => parseIntegrationRequired('yes')).toThrow(/WW_REQUIRE_INTEGRATION/);
  });
});

describe('integrationRequired', () => {
  it('ambient env değerini wrapper üzerinden okur', () => {
    const previous = process.env['WW_REQUIRE_INTEGRATION'];
    process.env['WW_REQUIRE_INTEGRATION'] = '1';
    try {
      expect(integrationRequired()).toBe(true);
    } finally {
      if (previous === undefined) delete process.env['WW_REQUIRE_INTEGRATION'];
      else process.env['WW_REQUIRE_INTEGRATION'] = previous;
    }
  });
});
