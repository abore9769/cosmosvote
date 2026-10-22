import { describe, it, expect } from 'vitest';
import { formatTokenAmount, sanitizeWalletMessage } from '../utils';

describe('formatTokenAmount', () => {
  it('formats integer amounts with no decimals', () => {
    expect(formatTokenAmount(1234567n, 0)).toBe('1,234,567');
  });

  it('formats amounts with decimals and appends CVT', () => {
    expect(formatTokenAmount(1234500n, 4)).toBe('123.45 CVT');
    expect(formatTokenAmount(1n, 6)).toBe('0.00 CVT');
  });
});

describe('sanitizeWalletMessage', () => {
  const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
  const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/;

  it('passes through plain ASCII unchanged', () => {
    const input = 'Payment for invoice #1234';
    const output = sanitizeWalletMessage(input);
    expect(output).toBe(input);
    expect(PRINTABLE_ASCII.test(output)).toBe(true);
    expect(CONTROL_CHARS.test(output)).toBe(false);
  });

  it('strips non-ASCII Unicode (Cyrillic)', () => {
    const output = sanitizeWalletMessage('Оплата заказа');
    expect(PRINTABLE_ASCII.test(output)).toBe(true);
    expect(CONTROL_CHARS.test(output)).toBe(false);
    expect(output).not.toContain('О');
  });

  it('strips non-ASCII Unicode (CJK)', () => {
    const output = sanitizeWalletMessage('支払い 123');
    expect(PRINTABLE_ASCII.test(output)).toBe(true);
    expect(CONTROL_CHARS.test(output)).toBe(false);
    expect(output).toContain('123');
    expect(output).not.toContain('支');
  });

  it('strips emoji', () => {
    const output = sanitizeWalletMessage('Thanks 🚀🎉');
    expect(PRINTABLE_ASCII.test(output)).toBe(true);
    expect(CONTROL_CHARS.test(output)).toBe(false);
    expect(output).not.toContain('🚀');
    expect(output).not.toContain('🎉');
    expect(output).toContain('Thanks');
  });

  it('strips null bytes', () => {
    const output = sanitizeWalletMessage('abc\u0000def');
    expect(output).not.toContain('\u0000');
    expect(PRINTABLE_ASCII.test(output)).toBe(true);
    expect(CONTROL_CHARS.test(output)).toBe(false);
  });

  it('strips C0 control characters', () => {
    const output = sanitizeWalletMessage('a\u0001b\u001bc');
    expect(output).not.toContain('\u0001');
    expect(output).not.toContain('\u001b');
    expect(PRINTABLE_ASCII.test(output)).toBe(true);
    expect(CONTROL_CHARS.test(output)).toBe(false);
  });

  it('strips DEL and C1 control characters', () => {
    const output = sanitizeWalletMessage('a\u007fb\u0085c');
    expect(output).not.toContain('\u007f');
    expect(output).not.toContain('\u0085');
    expect(PRINTABLE_ASCII.test(output)).toBe(true);
    expect(CONTROL_CHARS.test(output)).toBe(false);
  });

  it('handles mixed content', () => {
    const output = sanitizeWalletMessage('Pay\u0000ment 🚀 заказ\u001b 42');
    expect(PRINTABLE_ASCII.test(output)).toBe(true);
    expect(CONTROL_CHARS.test(output)).toBe(false);
    expect(output).toContain('42');
  });

  it('truncates overly long messages', () => {
    const input = 'A'.repeat(1000);
    const output = sanitizeWalletMessage(input);
    expect(output.length).toBeLessThanOrEqual(256);
    expect(PRINTABLE_ASCII.test(output)).toBe(true);
    expect(CONTROL_CHARS.test(output)).toBe(false);
  });

  it('returns an empty string for empty input', () => {
    expect(sanitizeWalletMessage('')).toBe('');
  });
});