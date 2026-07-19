// Copy to: shared/<name>.ts (shared FE+BE) | src/lib/<name>.ts (FE) | server/<name>.ts (BE)
// Deterministic, pure, no I/O. The caller fetches rows and hands them here; this
// stays trivially unit-testable. Mirrors shared/entitlements.ts, comparables.ts,
// alignment.ts. No LLM ever computes a score (rule 1).

export interface Inputs {
  // ... plain data the caller assembles from DB rows ...
  value: number;
}

export interface Result {
  // ... derived, deterministic output ...
  band: 'low' | 'mid' | 'high';
}

export function derive(inputs: Inputs): Result {
  const band = inputs.value >= 70 ? 'high' : inputs.value >= 40 ? 'mid' : 'low';
  return { band };
}
