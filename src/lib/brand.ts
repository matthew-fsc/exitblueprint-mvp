// The one place the product's own brand identity is defined. Every UI surface
// that names ExitBlueprint reads from here instead of hard-coding the string, so
// the wordmark is spelled one way and can never drift back into "Exit Blueprint"
// / "ExitBlueprint" inconsistency. The advisor's firm is the face on every
// client-facing surface (see lib/branding.tsx); this is the engine's own mark,
// used for the app chrome and the discreet "Powered by" endorsement.
export const BRAND = {
  // Canonical wordmark — one word, matches the strategy docs (20/40).
  name: 'ExitBlueprint',
  // The endorsement line under white-label: firm is the face, this is the engine.
  poweredBy: 'Powered by ExitBlueprint',
  // Registered legal entity. Distinct from the brand wordmark on purpose — the
  // entity name is a legal fact owned by counsel, not a styling choice, so the
  // binding legal instruments (Terms/DPA in pages/legal) keep their own copy.
  legalEntity: 'Exit Blueprint LLC',
} as const;
