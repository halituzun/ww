import { describe, expect, it } from 'vitest';
import { parseServerPort, serverPort } from './port.js';

describe('parseServerPort', () => {
  it.each([undefined, '', '   '])('%s için 4000 döndürür', (value) => {
    expect(parseServerPort(value)).toBe(4000);
  });

  it.each([
    ['1', 1],
    [' 4000 ', 4000],
    ['65535', 65_535],
  ])('%s değerini %s olarak ayrıştırır', (value, expected) => {
    expect(parseServerPort(value)).toBe(expected);
  });

  it.each(['0', '65536', '-1', '1.5', 'abc', '+4000'])('%s değerini reddeder', (value) => {
    expect(() => parseServerPort(value)).toThrow(/WW_PORT/);
  });
});

describe('serverPort', () => {
  it('ambient env değerini wrapper üzerinden okur', () => {
    const previous = process.env['WW_PORT'];
    process.env['WW_PORT'] = '5000';
    try {
      expect(serverPort()).toBe(5000);
    } finally {
      if (previous === undefined) delete process.env['WW_PORT'];
      else process.env['WW_PORT'] = previous;
    }
  });
});
