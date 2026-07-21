// The client document suite — one declarative catalog for every deliverable the
// platform assembles for a client. This is the single source of truth shared by
// the server-side PDF renderer (server/documents/catalog.ts) and the advisor's
// Deliverables studio (src/pages/DeliverablesPage.tsx), so the two can never
// drift on what documents exist, what they are called, or who may see them.
//
// A deliverable is always: deterministic scoring output (facts) + an AI-drafted
// or rule-composed narrative (prose FROM those facts, never computing a number)
// + firm branding → a branded PDF. The document TYPES live here; the narrative
// generation lives in server/narrative.ts and the PDF scaffolding in
// server/pdf.ts. Adding a client document is a single entry here plus its
// payload builder + HTML renderer — never a new scattered page and endpoint.

export type DocumentAudience = 'owner' | 'market';

export interface ClientDocumentType {
  // The stable key stored on generated_documents.doc_type and passed to the
  // generate-document / render-document-pdf endpoints.
  docType: 'owner_report' | 'delta_report' | 'cim';
  // Display title in the studio and document lists.
  title: string;
  // A one-line description of what the document is.
  blurb: string;
  // What the AI narrator does for this document, always FROM deterministic data.
  narratorNote: string;
  // Who the finished document is for.
  audience: DocumentAudience;
  // The download filename for the branded PDF.
  filename: string;
  // Whether the finished document is surfaced to the owner in the owner portal.
  // The CIM is buyer-facing marketing the advisor controls, never shown to the
  // owner (docs/17); the owner report is theirs; the delta report is an advisor
  // meeting artifact.
  ownerVisible: boolean;
  // The studio sub-tab key (also the :section route segment).
  section: 'owner' | 'delta' | 'cim';
}

// Ordered as they read in the Deliverables work stream (docs/17 §5): the owner's
// report, the quarterly progress artifact, then the market-facing memorandum.
export const CLIENT_DOCUMENT_TYPES: ClientDocumentType[] = [
  {
    docType: 'owner_report',
    section: 'owner',
    title: 'Owner report',
    blurb: "The owner's exit-readiness report — the score, what buyers would flag, and the plan.",
    narratorNote: "Drafts the narrative from this assessment's scores and flagged gaps.",
    audience: 'owner',
    filename: 'exit-readiness-report.pdf',
    ownerVisible: true,
  },
  {
    docType: 'delta_report',
    section: 'delta',
    title: 'Delta report',
    blurb: 'The quarterly progress artifact for the client meeting — movement since last time.',
    narratorNote: 'Composes the story from the deterministic comparison of this assessment against the prior one.',
    audience: 'owner',
    filename: 'delta-report.pdf',
    ownerVisible: false,
  },
  {
    docType: 'cim',
    section: 'cim',
    title: 'CIM',
    blurb: 'The Confidential Information Memorandum — the buyer-facing marketing document.',
    narratorNote: 'Assembles the memorandum from the company profile, strengths, and verified evidence — strengths only, no score.',
    audience: 'market',
    filename: 'confidential-information-memorandum.pdf',
    // Surfaced to the owner once the advisor finalizes it — RLS gates the owner's
    // read on finalized_at (migration 20260721000600), so an unreviewed
    // auto-generated draft of this buyer-facing document never reaches them.
    ownerVisible: true,
  },
];

export function documentType(docType: string): ClientDocumentType | undefined {
  return CLIENT_DOCUMENT_TYPES.find((d) => d.docType === docType);
}

export function documentTypeForSection(section: string): ClientDocumentType | undefined {
  return CLIENT_DOCUMENT_TYPES.find((d) => d.section === section);
}

// The set of doc_type values the document suite knows how to generate and render.
export const DOCUMENT_TYPE_KEYS = CLIENT_DOCUMENT_TYPES.map((d) => d.docType);
