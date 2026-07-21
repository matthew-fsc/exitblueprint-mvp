// ParserAdapter: the pluggable seam between an uploaded document and structured
// fields. NO parser vendor is hard-coded — the concrete adapter is chosen at
// runtime (resolveParser). Reducto / LlamaParse are future implementations of
// this same interface; the beta ships the manual adapter, which extracts nothing
// and leaves every value to be entered by a human reviewer (the complete path).
// Extraction accuracy is explicitly not a beta blocker.

export interface ExtractedField {
  fieldKey: string;
  value: string | null;
  questionCode?: string | null; // optional link to a scored question's code
  confidence?: number | null; // 0..1; null = not a probabilistic extraction
}

export interface ParseResult {
  parserName: string;
  classification: string | null;
  fields: ExtractedField[];
}

export interface ParseInput {
  bytes: Buffer;
  mimeType: string;
  filename: string;
  category: string | null;
}

export interface ParserAdapter {
  readonly name: string;
  parse(input: ParseInput): Promise<ParseResult>;
}

// The default: no automated extraction. Classification falls back to the
// advisor-provided category; fields are left empty for manual entry in review.
export class ManualParserAdapter implements ParserAdapter {
  readonly name = 'manual';
  async parse(input: ParseInput): Promise<ParseResult> {
    return { parserName: this.name, classification: input.category, fields: [] };
  }
}

// Fixture adapter for the sell-side pipeline and its golden tests: the uploaded
// document's bytes ARE a fixture JSON ({ classification, fields }), and the
// adapter returns those fields verbatim. This is the "stub adapter that returns
// fixtures" — no vendor, deterministic, and offline-testable. The real Reducto /
// LlamaParse adapters implement the same interface later.
export class FixtureParserAdapter implements ParserAdapter {
  readonly name = 'fixture';
  async parse(input: ParseInput): Promise<ParseResult> {
    // An engagement can legitimately hold documents that aren't fixtures for
    // this adapter — e.g. a P&L or revenue-by-customer CSV an advisor keeps as a
    // source file. The pipeline's parse step runs every non-rejected document
    // through the active parser, so a non-JSON source file must be a no-op
    // ("nothing to extract"), the same way the manual adapter treats any bytes —
    // not a hard failure that aborts the whole run. A document that CLAIMS to be
    // JSON (by mime type or extension) but doesn't parse is still a loud error,
    // so a genuinely broken fixture in a golden test fails as before.
    const claimsJson =
      input.mimeType === 'application/json' || input.filename.toLowerCase().endsWith('.json');
    let doc: { classification?: string | null; fields?: ExtractedField[] };
    try {
      doc = JSON.parse(input.bytes.toString('utf8'));
    } catch {
      if (claimsJson) throw new Error('fixture parser: document bytes are not valid JSON');
      return { parserName: this.name, classification: input.category, fields: [] };
    }
    return {
      parserName: this.name,
      classification: doc.classification ?? input.category,
      fields: Array.isArray(doc.fields) ? doc.fields : [],
    };
  }
}

// Resolve the active adapter without hard-coding a vendor. EB_PARSER selects it;
// unset → manual. Vendor adapters (reducto, llamaparse) are recognized names but
// not implemented in the beta — they throw so a misconfiguration is loud rather
// than silently degrading to manual.
export function resolveParser(): ParserAdapter {
  const which = (process.env.EB_PARSER ?? 'manual').toLowerCase();
  switch (which) {
    case 'manual':
      return new ManualParserAdapter();
    case 'fixture':
      return new FixtureParserAdapter();
    case 'reducto':
    case 'llamaparse':
      throw new Error(
        `parser '${which}' is not implemented in this build; unset EB_PARSER to use the manual adapter`,
      );
    default:
      throw new Error(`unknown EB_PARSER '${which}'`);
  }
}
