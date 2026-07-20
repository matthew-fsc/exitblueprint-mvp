// Legal / trust page content — a DRAFT engineering scaffold.
//
// IMPORTANT: This module is a *template*, not final legal text. Every document
// carries the DRAFT_BANNER below and every substantive clause that needs a real
// legal decision (retention periods, jurisdiction, liability caps, the
// contracting entity, dates) is marked with COUNSEL_TODO so counsel can find and
// complete it. Do not present any of this as the platform's binding terms until
// it has been reviewed and finalized by legal counsel.
//
// The one part that is intentionally *factual* is the sub-processor register:
// it is sourced from the real stack (CLAUDE.md "Stack", docs/13, docs/16) and
// mirrors what the in-app /security page tells advisors.

// Shown, unmissably, at the top of every legal page.
export const DRAFT_BANNER =
  'DRAFT — template pending review by legal counsel. Not the final published terms.';

// The marker counsel searches for to find every spot needing a real decision.
export const COUNSEL_TODO = '[to be completed by counsel]';

export interface LegalSection {
  heading: string;
  // Each string is a paragraph. Use COUNSEL_TODO inline where a real value or
  // commitment must be supplied.
  body: string[];
}

export interface LegalDoc {
  slug: 'terms' | 'privacy' | 'dpa' | 'subprocessors';
  title: string;
  subtitle: string;
  // Placeholder — counsel sets the real effective/last-updated date.
  lastUpdated: string;
  sections: LegalSection[];
}

export interface Subprocessor {
  name: string;
  purpose: string;
  dataCategory: string;
  region: string;
}

// ---------------------------------------------------------------------------
// Sub-processor register — FACTUAL.
// Sourced from CLAUDE.md ("Stack") and docs/13 / docs/16. These are the real
// third parties that process data on the platform's behalf. Keep this in sync
// with the in-app /security summary and seed/subprocessors.csv.
// ---------------------------------------------------------------------------
export const SUBPROCESSORS: Subprocessor[] = [
  {
    name: 'Supabase',
    purpose: 'Primary Postgres database and encrypted object storage',
    dataCategory:
      'All client records — companies, engagements, assessments, uploaded documents (encrypted at rest, row-level-security isolated per firm)',
    region: 'United States',
  },
  {
    name: 'Vercel',
    purpose: 'Frontend application hosting (edge / CDN delivery of the web app)',
    dataCategory: 'Transient request/response only; no durable client records stored',
    region: 'United States',
  },
  {
    name: 'Render',
    purpose:
      'Server-side compute service (narrative generation, PDF rendering, webhook endpoints)',
    dataCategory:
      'Report inputs processed in memory per request; no durable client records stored',
    region: 'United States',
  },
  {
    name: 'Clerk',
    purpose: 'Authentication and identity provider (Organizations map to firms)',
    dataCategory:
      'Account identity — names, email addresses, and authentication credentials for advisors and owners',
    region: 'United States',
  },
  {
    name: 'Stripe',
    purpose: 'Subscription billing and payment processing',
    dataCategory: 'Firm billing contact details and payment information',
    region: 'United States',
  },
  {
    name: 'Anthropic',
    purpose: 'AI narrative generation drafted from already-structured assessment data',
    dataCategory:
      'Report inputs only — never used to compute or influence a readiness score, and not used to train models',
    region: 'United States',
  },
];

// ---------------------------------------------------------------------------
// Terms of Service — TEMPLATE (bodies pending counsel).
// ---------------------------------------------------------------------------
export const termsDoc: LegalDoc = {
  slug: 'terms',
  title: 'Terms of Service',
  subtitle: 'The agreement governing use of the Exit Blueprint platform.',
  lastUpdated: COUNSEL_TODO,
  sections: [
    {
      heading: 'Acceptance of terms',
      body: [
        `These Terms of Service govern access to and use of the Exit Blueprint platform (the "Service"). By creating an account or using the Service, the customer agrees to these terms. ${COUNSEL_TODO}: confirm the contracting entity name, the definition of "customer" (advisor firm vs. individual user), and how acceptance is recorded.`,
      ],
    },
    {
      heading: 'Accounts and eligibility',
      body: [
        'Access is provisioned to M&A advisor firms and, where enabled, to the business owners they invite. Firms and users are responsible for maintaining the confidentiality of their credentials and for all activity under their accounts.',
        `${COUNSEL_TODO}: eligibility requirements, minimum age/authority to bind a firm, and account-suspension rights.`,
      ],
    },
    {
      heading: 'Acceptable use',
      body: [
        'Customers may not misuse the Service — including attempting to access another firm’s data, circumventing security or tenancy controls, reverse-engineering the platform, or uploading unlawful content or content they lack the right to share.',
        `${COUNSEL_TODO}: full acceptable-use list, prohibited-content categories, and enforcement/remedies.`,
      ],
    },
    {
      heading: 'Fees and billing',
      body: [
        'The Service is offered on a subscription basis. Plan, seat, and engagement limits are as set out in the applicable order or plan selection; billing is processed through our payment processor (see the Sub-processors list).',
        `${COUNSEL_TODO}: pricing terms, billing cycle, taxes, renewal and auto-renewal, refunds, and late/non-payment consequences. During the current beta, participating firms may be provided complimentary access; counsel to confirm how beta terms interact with paid terms.`,
      ],
    },
    {
      heading: 'Intellectual property',
      body: [
        'The platform, its scoring methodology, and all related materials are owned by the provider. Customers retain ownership of the business and assessment data they submit and grant the provider the limited rights needed to operate the Service and generate the reports and analyses they request.',
        `${COUNSEL_TODO}: license grant scope, feedback license, and rights in AI-generated narrative output.`,
      ],
    },
    {
      heading: 'AI-generated content',
      body: [
        'Reports, briefs, and summaries may include narrative drafted by an AI service from the customer’s own structured data. This narrative is provided as a draft aid, is labeled as such, and does not constitute financial, legal, tax, or investment advice. Readiness scores themselves are produced by deterministic, rule-based logic and are not generated or influenced by AI.',
        `${COUNSEL_TODO}: disclaimer language for AI output and allocation of responsibility for reliance on it.`,
      ],
    },
    {
      heading: 'Disclaimers',
      body: [
        'The Service is provided "as is" and "as available" without warranties of any kind except as expressly stated. The provider does not warrant that the Service will be uninterrupted or error-free, and does not provide investment, legal, tax, or accounting advice.',
        `${COUNSEL_TODO}: full warranty disclaimer and any jurisdiction-specific carve-outs.`,
      ],
    },
    {
      heading: 'Limitation of liability',
      body: [
        `To the maximum extent permitted by law, the provider’s liability arising out of or relating to the Service is limited. ${COUNSEL_TODO}: liability cap amount/formula, excluded damages, and exceptions. Do not treat any figure as agreed until counsel supplies it.`,
      ],
    },
    {
      heading: 'Termination',
      body: [
        'Either party may terminate in accordance with the applicable order and these terms. On termination, the customer’s data is handled per the Privacy Policy and Data Processing Addendum — exported in standard formats and then deleted per the firm’s instruction.',
        `${COUNSEL_TODO}: notice periods, termination-for-cause triggers, and effect of termination on fees.`,
      ],
    },
    {
      heading: 'Governing law and disputes',
      body: [
        `These terms are governed by the laws of ${COUNSEL_TODO} (governing jurisdiction), and disputes are resolved as set out here — ${COUNSEL_TODO}: venue, arbitration vs. litigation, and class-action provisions.`,
      ],
    },
    {
      heading: 'Changes to these terms',
      body: [
        `The provider may update these terms; material changes will be communicated as described here. ${COUNSEL_TODO}: notice mechanism and how continued use constitutes acceptance.`,
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Privacy Policy — TEMPLATE. Security-measures section cites REAL controls
// (docs/13, docs/16); everything customer-specific is marked for counsel.
// ---------------------------------------------------------------------------
export const privacyDoc: LegalDoc = {
  slug: 'privacy',
  title: 'Privacy Policy',
  subtitle: 'How Exit Blueprint collects, uses, and protects information.',
  lastUpdated: COUNSEL_TODO,
  sections: [
    {
      heading: 'Overview',
      body: [
        'This policy describes how the Exit Blueprint platform handles information for the advisor firms that use it and the business owners they assess. Because the platform holds sensitive business and personal-financial information, data handling is a first-order design concern.',
        `${COUNSEL_TODO}: the legal entity acting as controller/operator, and the customer segments and regions this policy covers.`,
      ],
    },
    {
      heading: 'Information we collect',
      body: [
        'Account and identity information (names, email addresses, firm/organization affiliation) needed to provision and authenticate users; business and assessment data submitted by advisors and owners (financial summaries, assessment answers, uploaded documents, and limited owner personal-financial-readiness inputs); and usage information generated as the Service is operated.',
        `${COUNSEL_TODO}: confirm the full data inventory and whether any special/sensitive categories are in scope.`,
      ],
    },
    {
      heading: 'How we use information',
      body: [
        'To provide the Service — measuring exit readiness, diagnosing gaps, prescribing remediation, and generating reports and narrative from a firm’s own structured data; to authenticate users and secure the platform; to bill for the Service; and to support and improve the platform.',
        'Information is not sold. AI narrative generation uses report inputs only and is never used to compute or influence a readiness score, nor to train third-party models.',
        `${COUNSEL_TODO}: legal bases for processing (where applicable) and any secondary uses.`,
      ],
    },
    {
      heading: 'Sharing and sub-processors',
      body: [
        'Information is shared with the vetted third-party sub-processors that operate the platform (hosting, database and storage, authentication, billing, and AI narrative generation). Each sub-processor is limited to the data needed for its function. The current sub-processor list, with purpose and data category, is published on the Sub-processors page.',
        `${COUNSEL_TODO}: disclosures for legal process, corporate transactions, and any advisor-directed sharing.`,
      ],
    },
    {
      heading: 'Security measures',
      body: [
        // These are REAL, per docs/13-security-summary.md and docs/16.
        'Client data lives in a Postgres database (Supabase) where every domain table carries a firm identifier and is protected by row-level security, so a firm can read and write only its own records — enforced in the database, not just the application, and covered by an automated isolation test suite.',
        'Uploaded source documents are encrypted at rest with AES-256-GCM, with the encryption key supplied separately and never stored alongside the data; all traffic is over TLS. Source documents are served only through short-expiry signed URLs, never durable public links.',
        'Access is governed by roles (admin, advisor, reviewer, owner); multi-factor authentication is required for advisor and admin accounts; sessions are automatically signed out after 30 minutes of inactivity; and every read of a client document or report is written to an append-only audit log. Assessments are immutable snapshots — corrections create a new version rather than mutating history.',
      ],
    },
    {
      heading: 'Data retention',
      body: [
        `Records are retained for the life of an engagement and its readiness history. ${COUNSEL_TODO}: specific retention periods per data category, backup-retention window, and post-termination deletion timeline.`,
      ],
    },
    {
      heading: 'Your rights',
      body: [
        `Depending on jurisdiction, individuals may have rights to access, correct, delete, or port their information. ${COUNSEL_TODO}: enumerate applicable rights (e.g., GDPR/CCPA as relevant), how to exercise them, and response timelines. Requests concerning a firm’s client data are typically directed through the advisor firm as the controller.`,
      ],
    },
    {
      heading: 'International data transfers',
      body: [
        `Data is processed in the United States. ${COUNSEL_TODO}: transfer mechanisms and safeguards if the Service is offered to customers or data subjects outside the United States.`,
      ],
    },
    {
      heading: 'Contact',
      body: [
        `Questions about this policy or a privacy request can be directed to ${COUNSEL_TODO}: privacy contact entity, email address, and postal address.`,
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Data Processing Addendum — TEMPLATE. References the sub-processor list and the
// real security posture; commitments and legal terms are for counsel.
// ---------------------------------------------------------------------------
export const dpaDoc: LegalDoc = {
  slug: 'dpa',
  title: 'Data Processing Addendum',
  subtitle: 'Terms governing processing of personal data on behalf of customer firms.',
  lastUpdated: COUNSEL_TODO,
  sections: [
    {
      heading: 'Roles and definitions',
      body: [
        'This Addendum applies where the provider processes personal data on behalf of a customer firm in connection with the Service. In general the customer firm acts as the controller (or business) of its client data and the provider acts as the processor (or service provider).',
        `${COUNSEL_TODO}: adopt precise definitions from the applicable framework(s), confirm controller/processor roles, and reconcile with the main agreement.`,
      ],
    },
    {
      heading: 'Scope and nature of processing',
      body: [
        'The provider processes customer personal data only to provide the Service — measuring exit readiness, generating reports and narrative from the firm’s structured data, authenticating users, and supporting the platform — and on the customer’s documented instructions.',
        `${COUNSEL_TODO}: categories of data subjects, categories of personal data, and the duration of processing.`,
      ],
    },
    {
      heading: 'Sub-processors',
      body: [
        'The provider engages the sub-processors listed on the Sub-processors page to help deliver the Service. Each is bound to data-protection obligations consistent with this Addendum, and the provider remains responsible for their performance.',
        `${COUNSEL_TODO}: notice mechanism for sub-processor changes, customer objection rights, and flow-down contractual requirements.`,
      ],
    },
    {
      heading: 'Security measures',
      body: [
        // REAL controls per docs/13 and docs/16.
        'The provider maintains technical and organizational measures including: row-level security enforcing per-firm data isolation in the database; AES-256-GCM encryption of uploaded documents at rest with keys stored separately from the data; TLS in transit; short-expiry signed URLs for document delivery; role-based access control; required multi-factor authentication for advisor and admin accounts; automatic session timeout after inactivity; and append-only audit logging of document and report reads.',
        `${COUNSEL_TODO}: attach the definitive security-measures schedule and any certifications (e.g., SOC 2 status, which is a tracked roadmap item).`,
      ],
    },
    {
      heading: 'Data-subject requests',
      body: [
        `The provider will assist the customer, taking into account the nature of processing, in responding to data-subject requests it receives that relate to the customer’s data. ${COUNSEL_TODO}: assistance scope, timelines, and how requests are routed.`,
      ],
    },
    {
      heading: 'Personal-data-breach notification',
      body: [
        `The provider will notify the customer of a personal-data breach affecting customer data without undue delay after becoming aware of it. ${COUNSEL_TODO}: contractual notification deadline (a ≤30-day standard clause is planned per docs/16; target 72 hours), content of the notice, and cooperation obligations. Do not treat any deadline as contractually committed until counsel finalizes it.`,
      ],
    },
    {
      heading: 'Return and deletion of data',
      body: [
        'On termination, the customer’s data is exported in industry-standard formats (CSV/JSON plus original documents) and then deleted per the customer’s instruction; the firm-scoped schema makes a clean per-tenant export and deletion tractable.',
        `${COUNSEL_TODO}: deletion timelines, backup-expiry handling, and any certification-of-deletion commitment.`,
      ],
    },
    {
      heading: 'Audits and cooperation',
      body: [
        `The provider will make available information reasonably necessary to demonstrate compliance with this Addendum. ${COUNSEL_TODO}: audit rights, frequency, and confidentiality conditions.`,
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Sub-processors — the register is FACTUAL (rendered as a table on the page from
// SUBPROCESSORS above). These sections frame it.
// ---------------------------------------------------------------------------
export const subprocessorsDoc: LegalDoc = {
  slug: 'subprocessors',
  title: 'Sub-processors',
  subtitle: 'Third parties that process data to help operate the Exit Blueprint platform.',
  lastUpdated: COUNSEL_TODO,
  sections: [
    {
      heading: 'About this list',
      body: [
        'The providers below process customer data on the platform’s behalf, each limited to the data needed for its function. This register reflects the platform’s actual stack and mirrors the summary shown to advisors on the in-app security page.',
        'All listed sub-processors operate in the United States. Each processes data only to deliver its function and under contractual data-protection obligations.',
      ],
    },
    {
      heading: 'Changes to this list',
      body: [
        `Changes to the sub-processor list are reflected here and in the in-app security summary. ${COUNSEL_TODO}: advance-notice period for new sub-processors and how customers are notified and may object.`,
      ],
    },
  ],
};

// Registry consumed by the pages and tests.
export const LEGAL_DOCS: Record<LegalDoc['slug'], LegalDoc> = {
  terms: termsDoc,
  privacy: privacyDoc,
  dpa: dpaDoc,
  subprocessors: subprocessorsDoc,
};
