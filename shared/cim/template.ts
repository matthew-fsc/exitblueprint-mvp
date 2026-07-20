// The Confidential Information Memorandum (CIM) template — the buyer-facing
// marketing structure the platform assembles from an engagement's collected
// evidence. This is document methodology, kept in code (like the report prompts
// and the PDF scaffolding), not a scored rubric: it is not versioned per
// rubric_version and is not firm-edited in this slice. A DB-backed, firm-editable
// template is a follow-up if firms need to customise the section set.
//
// The one load-bearing rule here: a CIM section maps to the SAME evidence
// taxonomy the data room already uses (docs/15 decision 4 — the data room and
// the gap taxonomy are one taxonomy, never two parallel lists). Each `evidence`
// entry is a `data_room_sections.code`, so "posture evidence collection for the
// CIM" is a rollup over the existing per-engagement data-room readiness, not a
// second checklist. The eight sections below reference the seven data-room
// sections (FIN, OPS, HR, CUS, PIP, CMP, LEG) exactly once between them, so the
// coverage view accounts for every collected item with no double-counting.

export interface CimSectionDef {
  code: string;
  name: string;
  // What this section presents to a prospective buyer — the guidance the
  // narrative composer and the AI prompt both write against.
  narrativeGuidance: string;
  // The data_room_sections.code(s) whose collected, verified documents back this
  // section. Empty for narrative-synthesis sections (highlights, positioning,
  // transaction rationale) that are written from the strengths/valuation payload
  // rather than a specific diligence folder.
  evidence: string[];
}

// The seven data-room sections (mirrors seed/data-room-sections.csv). Kept here
// so the template can be validated as complete against the evidence taxonomy.
export const DATA_ROOM_SECTION_CODES = ['FIN', 'OPS', 'HR', 'CUS', 'PIP', 'CMP', 'LEG'] as const;

export const CIM_SECTIONS: CimSectionDef[] = [
  {
    code: 'HIGHLIGHTS',
    name: 'Investment Highlights',
    narrativeGuidance:
      'The three to five headline reasons a buyer should be interested, drawn from the strongest business areas and any verified, differentiated facts. Lead with what makes the business attractive.',
    evidence: [],
  },
  {
    code: 'OVERVIEW',
    name: 'Company Overview',
    narrativeGuidance:
      'What the company does, its history and ownership, where it operates, and its scale. A clear, factual introduction a buyer can orient to.',
    evidence: ['LEG'],
  },
  {
    code: 'OFFERING',
    name: 'Products & Services',
    narrativeGuidance:
      'The offering — what is sold, how it is differentiated, and any proprietary product, specification, or intellectual property that a buyer acquires.',
    evidence: ['PIP'],
  },
  {
    code: 'MARKET',
    name: 'Market & Growth Opportunity',
    narrativeGuidance:
      'The market the business serves, its position within it, and the concrete avenues for a buyer to grow it. Positioning and opportunity, stated without hype.',
    evidence: [],
  },
  {
    code: 'CUSTOMERS',
    name: 'Customers & Revenue',
    narrativeGuidance:
      'The customer base and the durability of the demand engine: relationships, contracts, and the quality and repeatability of revenue.',
    evidence: ['CUS'],
  },
  {
    code: 'OPERATIONS',
    name: 'Operations & Organization',
    narrativeGuidance:
      'How the business runs and who runs it: operational capability, the team and management depth, and the facilities/compliance footing that transfers at close.',
    evidence: ['OPS', 'HR', 'CMP'],
  },
  {
    code: 'FINANCIAL',
    name: 'Financial Overview',
    narrativeGuidance:
      'The financial profile at a summary level: scale, profitability, and the quality of the reported numbers. Use only the figures supplied; never state an asking price.',
    evidence: ['FIN'],
  },
  {
    code: 'OPPORTUNITY',
    name: 'The Opportunity',
    narrativeGuidance:
      'The transaction rationale: why the owner is exploring a transaction and why this is an attractive moment for the right buyer to engage. Forward-looking but grounded.',
    evidence: [],
  },
];
