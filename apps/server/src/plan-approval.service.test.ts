import { describe, expect, it } from 'vitest';
import { parseApprovalInput } from './plan-approval.service.js';

describe('parseApprovalInput', () => {
  it('onayı kabul eder', () => {
    expect(parseApprovalInput({ approved: true })).toEqual({ approved: true });
  });

  it('reddi kabul eder ve notu taşır', () => {
    expect(parseApprovalInput({ approved: false, note: 'kapsam belirsiz' }))
      .toEqual({ approved: false, note: 'kapsam belirsiz' });
  });

  // Kararsız bir onay isteği sessizce "onay" sayılmamalı.
  it('approved alanı zorunludur', () => {
    expect(() => parseApprovalInput({ note: 'x' })).toThrow();
  });

  it('metin approved’ı reddeder', () => {
    expect(() => parseApprovalInput({ approved: 'evet' })).toThrow();
  });

  it('bilinmeyen alanı reddeder', () => {
    expect(() => parseApprovalInput({ approved: true, uydurma: 1 })).toThrow();
  });
});
