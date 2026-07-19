// Copy to: tests/<name>.test.ts  — one describe per exported fn, cover the branches.
import { describe, expect, it } from 'vitest';
import { derive } from '../shared/<name>'; // adjust path to where you put the module

describe('derive', () => {
  it('bands by threshold', () => {
    expect(derive({ value: 80 }).band).toBe('high');
    expect(derive({ value: 50 }).band).toBe('mid');
    expect(derive({ value: 10 }).band).toBe('low');
  });

  it('is inclusive on the boundary', () => {
    expect(derive({ value: 70 }).band).toBe('high');
    expect(derive({ value: 40 }).band).toBe('mid');
  });
});
