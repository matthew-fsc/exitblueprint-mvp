import { describe, expect, it } from 'vitest';
import { humanizeKey, formatFieldValue } from '../src/lib/format';

describe('humanizeKey', () => {
  it('turns snake_case field keys into readable labels', () => {
    expect(humanizeKey('annual_revenue')).toBe('Annual revenue');
    expect(humanizeKey('customer_concentration')).toBe('Customer concentration');
  });
  it('cases finance acronyms correctly', () => {
    expect(humanizeKey('ebitda')).toBe('EBITDA');
    expect(humanizeKey('gaap_proximity')).toBe('GAAP proximity');
    expect(humanizeKey('top_customer_pct')).toBe('Top customer %');
  });
  it('handles empty / nullish input', () => {
    expect(humanizeKey(null)).toBe('—');
    expect(humanizeKey('')).toBe('—');
  });
});

describe('formatFieldValue', () => {
  it('formats money fields as currency — never a bare integer', () => {
    expect(formatFieldValue('annual_revenue', 10000000)).toBe('$10,000,000');
    expect(formatFieldValue('ebitda', 2000000)).toBe('$2,000,000');
  });
  it('formats ratio/percent fields as a percentage', () => {
    expect(formatFieldValue('top_customer_pct', 0.32)).toBe('32%');
  });
  it('gives other numbers thousands separators', () => {
    expect(formatFieldValue('employee_count', 1250)).toBe('1,250');
  });
  it('coerces numeric strings and passes text through', () => {
    expect(formatFieldValue('ebitda', '2000000')).toBe('$2,000,000');
    expect(formatFieldValue('top_customer_name', 'Acme')).toBe('Acme');
    expect(formatFieldValue('annual_revenue', null)).toBe('—');
  });
});
