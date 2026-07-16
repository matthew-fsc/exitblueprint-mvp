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
    let doc: { classification?: string | null; fields?: ExtractedField[] };
    try {
      doc = JSON.parse(input.bytes.toString('utf8'));
    } catch {
      throw new Error('fixture parser: document bytes are not valid JSON');
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
