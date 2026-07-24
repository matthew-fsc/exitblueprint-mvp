// Intelligence-runtime guards (docs/sellside-ai/05 §3). The two anti-hallucination
// post-checks the shared runtime enforces, moved here VERBATIM from server/narrative.ts
// so every grounded-generation caller polices output the same way. Pure, no I/O,
// no imports beyond types — this module is a leaf (the runtime imports it; it
// imports nothing from the platform), which is what keeps the runtime free of any
// import cycle back through narrative.ts.

// --- Numeral post-check (docs/04, amended S4.5 B2) ------------------------------
// Strict: every numeral in the output must appear in the input payload.
// Whitelist: years, markdown list numbering, and numbers present in the payload.

const NUMERAL = /\d+(?:\.\d+)?/g;

export function numeralPostCheck(outputMd: string, payload: unknown): string[] {
  const allowed = new Set<string>(JSON.stringify(payload).match(NUMERAL) ?? []);
  const violations: string[] = [];
  for (const line of outputMd.split('\n')) {
    // markdown list numbering ("1. ..." / "2) ...") is whitelisted
    const body = line.replace(/^\s*\d+[.)]\s/, '');
    for (const numeral of body.match(NUMERAL) ?? []) {
      if (allowed.has(numeral)) continue;
      if (/^(19|20)\d{2}$/.test(numeral)) continue; // years
      violations.push(numeral);
    }
  }
  return [...new Set(violations)];
}

// --- Citation contract post-check (docs/sellside-ai/01, "The citation contract")
// The source-score guard that will police MARKET claims once retrieved market
// context is injected into a deliverable's payload (a later slice — this is NOT
// wired into generateDocument yet). It extends the numeral firewall: where
// numeralPostCheck proves a numeral was in the data, this proves a *market*
// numeral is rendered ADJACENT to the citation of the passage it came from, so
// an advisor can put the figure in front of a buyer with its source attached.
//
// Rule: for each retrieved passage, take the numerals present in its body (the
// same NUMERAL regex the firewall uses). Any such market numeral appearing on an
// output line must have that passage's cite_id on the SAME line — either raw
// (PLACE-FS-01) or bracketed ([PLACE-FS-01]); both satisfy a substring check.
// Numerals that are not in any passage body (years, payload figures) are the
// numeral firewall's job, not this one, so they are never policed here. No
// passages → nothing to police → []. Pure: no I/O, changes no existing behavior.
export function citationPostCheck(
  outputMd: string,
  marketContext: { passages: { cite_id: string; body: string }[] },
): string[] {
  const violations: string[] = [];
  const passages = marketContext.passages.map((p) => ({
    cite_id: p.cite_id,
    numerals: new Set(p.body.match(NUMERAL) ?? []),
  }));
  for (const line of outputMd.split('\n')) {
    const lineNumerals = new Set(line.match(NUMERAL) ?? []);
    if (lineNumerals.size === 0) continue;
    for (const passage of passages) {
      if (line.includes(passage.cite_id)) continue; // cited on this line — fine
      for (const numeral of passage.numerals) {
        if (!lineNumerals.has(numeral)) continue;
        violations.push(
          `market figure ${numeral} stated without its [${passage.cite_id}] citation`,
        );
      }
    }
  }
  return [...new Set(violations)];
}
