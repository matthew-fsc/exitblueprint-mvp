// Legal / trust page content for the Exit Blueprint beta.
//
// These are REAL, product-grounded beta terms — not a scaffold. Every security
// and data-handling statement below reflects a control that is actually
// implemented (see docs/13, docs/16, CLAUDE.md), and the commercial terms use
// conservative, defensible defaults so the pages read as complete beta terms.
//
// TWO things a human still owns before these go live:
//   1. BEFORE PUBLISHING — fill the six business facts in FILL below. Until you
//      do, they render as visible [bracketed] placeholders on the page.
//   2. BEFORE CHARGING PAID CUSTOMERS — have counsel review. The specific items
//      to confirm are enumerated in COUNSEL_REVIEW_ITEMS (a checklist, not shown
//      to users). The defaults here are reasonable for a comped beta; they are
//      not a substitute for a lawyer signing off before money changes hands.

// The provider/product name used throughout the prose.
export const PROVIDER_NAME = 'Exit Blueprint';

// The six business facts only you can supply. Fill these in before publishing.
// Everything else in this file is written out — these are the only values that
// render as visible placeholders until set.
export const FILL = {
  entity: 'Exit Blueprint LLC',
  address: '[business mailing address]',
  contactEmail: '[privacy & legal contact email]',
  governingLaw: 'the State of Florida',
  // Defaults to statewide venue; narrow to a county (e.g. "Miami-Dade County,
  // Florida") once the principal place of business is set.
  venue: 'the State of Florida',
  effectiveDate: 'July 1, 2026',
};

// Items for counsel to confirm before the Service is sold to paid customers.
// NOT shown to users — this is the review checklist. The user-facing text above
// uses conservative defaults so the pages are complete in the meantime.
export const COUNSEL_REVIEW_ITEMS: string[] = [
  'Contracting entity, authority to bind a firm, and how acceptance is recorded (consider an explicit "I agree" checkbox at signup rather than use-implies-acceptance).',
  'Limitation-of-liability cap and excluded damages (default: the greater of fees paid in the prior 12 months or US$100) and any carve-outs (e.g., indemnity, confidentiality).',
  'Governing law and venue, and whether to require arbitration and a class-action waiver.',
  'Data-retention periods and the breach-notification deadline (defaults: live-data deletion within 30 days of request; backups purged within 60 days; breach notice "without undue delay").',
  'Enumerated statutory-rights language (e.g., GDPR / CCPA) if you serve those markets, and international-transfer mechanisms if you take non-US data.',
  'Confirm the actual Supabase backup-retention window matches the deletion timelines stated in the Privacy Policy and DPA (docs/08 currently marks this [confirm]).',
  'The engagement data-use consents (benchmarking / anonymized aggregation / outcome tracking) are PRE-CHECKED opt-out in the New-engagement dialog. Valid for US, de-identified, advisor-recorded consent; a pre-ticked box is NOT valid consent under GDPR — switch them to default-unchecked before offering the Service where GDPR-style affirmative consent applies.',
];

// Plain-language beta summary shown at the top of every legal page. Honest and
// non-alarming: it frames these as the current beta terms (binding, but the
// Service is for evaluation and may change) and surfaces the three disclaimers
// that matter most, without falsely claiming the terms are counsel-approved.
export const BETA_NOTICE = {
  title: 'Beta terms — at a glance',
  points: [
    'These are the current terms for the Exit Blueprint beta. They are binding, but the Service is provided for evaluation and may change, be limited, or be discontinued.',
    'Exit Blueprint is a software tool. It is not financial, legal, tax, investment, accounting, or brokerage advice, and its scores, valuations, and narrative are not a valuation, appraisal, fairness opinion, or audit.',
    'Readiness scores are produced by deterministic, rule-based code. AI is used only to draft narrative from your own data — it never computes or influences a score, and your data is not used to train AI models.',
    'The effective date below identifies the current version. We may update these terms and will post changes here.',
  ],
};

export interface LegalSection {
  heading: string;
  // Each string is a paragraph.
  body: string[];
}

export interface LegalDoc {
  slug: 'terms' | 'privacy' | 'dpa' | 'subprocessors';
  title: string;
  subtitle: string;
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
// Terms of Service.
// ---------------------------------------------------------------------------
export const termsDoc: LegalDoc = {
  slug: 'terms',
  title: 'Terms of Service',
  subtitle: 'The agreement governing use of the Exit Blueprint platform.',
  lastUpdated: FILL.effectiveDate,
  sections: [
    {
      heading: 'Agreement to these terms',
      body: [
        `The Exit Blueprint platform (the "Service") is operated by ${FILL.entity} ("Exit Blueprint", "we", "us"). These Terms of Service ("Terms") govern access to and use of the Service.`,
        'By creating an account, or by accessing or using the Service, you agree to these Terms. If you use the Service on behalf of an advisor firm or other organization, you represent that you are authorized to accept these Terms on its behalf, and "you" refers to that organization.',
      ],
    },
    {
      heading: 'Beta service',
      body: [
        'The Service is currently offered as a beta, for evaluation. Beta access may be provided free of charge and may be changed, limited, suspended, or discontinued at any time. The Service may contain errors and may produce incomplete or inaccurate results.',
        'Except where separately agreed in writing, we make no commitment during the beta as to uptime, availability, support response, or data-loss prevention beyond the measures described in our Privacy Policy. Do not use the Service as your sole system of record for anything you cannot afford to re-enter.',
      ],
    },
    {
      heading: 'Accounts and eligibility',
      body: [
        'Access is provisioned to M&A advisor firms and, where enabled, to the business owners they invite. You must be at least 18 years old and able to form a binding contract.',
        'You are responsible for maintaining the confidentiality of your credentials and for all activity under your account, and you agree to notify us promptly of any unauthorized use. We may suspend or terminate an account that violates these Terms or that we reasonably believe poses a security, legal, or operational risk.',
      ],
    },
    {
      heading: 'Customer data and your responsibilities',
      body: [
        'You may submit business and personal-financial information about the companies and owners you advise ("Customer Data"). As between you and us, Customer Data is yours.',
        'You represent and warrant that you have all rights, consents, and authority necessary to provide Customer Data to the Service and to have it processed as described in the Privacy Policy and the Data Processing Addendum. You are responsible for the accuracy of Customer Data and for obtaining any consent your clients require.',
        'You agree not to upload data you lack the right to share, and not to submit categories of data the Service is not designed to handle — for example, payment-card data outside the billing flow, government-issued identification numbers, or protected health information.',
      ],
    },
    {
      heading: 'Acceptable use',
      body: [
        'You may not: attempt to access another firm’s data or otherwise circumvent the Service’s security or multi-tenancy controls; reverse-engineer or copy the Service or its scoring methodology except to the extent that restriction is prohibited by law; upload unlawful, infringing, or malicious content; interfere with or place an undue load on the Service; or use the Service to build a competing product.',
        'Outputs are decision-support, not decisions. You will apply your own professional judgment and human review before relying on or sharing any output.',
      ],
    },
    {
      heading: 'Fees and billing',
      body: [
        'If you subscribe to a paid plan, the applicable fees, seat limits, and engagement limits are those shown at plan selection or in your order. Fees are billed through our payment processor (Stripe).',
        'Unless stated otherwise, fees are non-refundable and are exclusive of taxes, which are your responsibility. Paid subscriptions renew for successive terms unless cancelled before the renewal date. During the beta, access may be complimentary; if we begin charging, we will provide notice, and paid terms will apply on a going-forward basis.',
      ],
    },
    {
      heading: 'Intellectual property',
      body: [
        'The Service, its scoring methodology (including the Diligence Readiness Score and Owner Readiness Index), and all related software and materials are owned by Exit Blueprint and its licensors. Nothing in these Terms transfers ownership of the Service to you.',
        'You retain ownership of Customer Data and of the reports and outputs generated for you. You grant us the limited, non-exclusive rights needed to host and process Customer Data to operate the Service and to produce the reports and analyses you request. If you send us suggestions or feedback, you grant us a perpetual, royalty-free right to use them to improve the Service.',
      ],
    },
    {
      heading: 'AI-generated content',
      body: [
        'Reports, briefs, and summaries may include narrative drafted by an AI service from your own structured data. This narrative is provided as a labeled draft aid, and you are responsible for reviewing it before you rely on it or share it.',
        'Readiness scores themselves are produced by deterministic, rule-based logic. They are not generated or influenced by AI, and your data is not used to train AI models.',
      ],
    },
    {
      heading: 'No professional advice',
      body: [
        'Exit Blueprint is a software tool. Using it does not create an advisory, brokerage, or fiduciary relationship between you and us, and we do not provide financial, legal, tax, investment, accounting, or brokerage advice.',
        'Readiness scores, valuations, comparables, and narrative are informational estimates generated from the data you provide. They are not a valuation, appraisal, fairness opinion, audit, or a recommendation to buy or sell any business or security. You remain solely responsible for the advice you give your clients and for your own professional and regulatory obligations.',
      ],
    },
    {
      heading: 'Third-party services',
      body: [
        'The Service relies on the third-party sub-processors listed on the Sub-processors page. Their services are outside our direct control, and except as expressly stated we are not responsible for them. Your use of any linked third-party service is governed by that third party’s terms.',
      ],
    },
    {
      heading: 'Disclaimer of warranties',
      body: [
        'The Service is provided "as is" and "as available", without warranties of any kind, whether express, implied, or statutory, including any implied warranties of merchantability, fitness for a particular purpose, and non-infringement.',
        'We do not warrant that the Service will be uninterrupted, timely, secure, or error-free, or that any result, score, or estimate it produces is accurate or complete. Some jurisdictions do not allow the exclusion of certain warranties, so some of these exclusions may not apply to you.',
      ],
    },
    {
      heading: 'Limitation of liability',
      body: [
        // COUNSEL_REVIEW: confirm the cap amount, excluded damages, and carve-outs.
        // Default below (greater of 12-month fees or US$100) is a standard,
        // defensible beta cap; for a comped firm the cap is effectively US$100.
        'To the maximum extent permitted by law, Exit Blueprint will not be liable for any indirect, incidental, special, consequential, or punitive damages, or for any lost profits, revenue, goodwill, or data, arising out of or relating to the Service.',
        'To the maximum extent permitted by law, our total aggregate liability arising out of or relating to the Service will not exceed the greater of (a) the fees you paid us for the Service in the twelve months before the event giving rise to the claim, or (b) one hundred US dollars (US$100). Nothing in these Terms limits liability that cannot be limited under applicable law.',
      ],
    },
    {
      heading: 'Indemnification',
      body: [
        'You will defend, indemnify, and hold harmless Exit Blueprint from and against third-party claims, damages, and reasonable costs arising out of Customer Data, your use of the Service, or your breach of these Terms — including any claim that you lacked the rights or consents needed to provide Customer Data.',
      ],
    },
    {
      heading: 'Term and termination',
      body: [
        'These Terms apply while you use the Service. You may stop using the Service at any time, and either party may terminate a paid subscription in accordance with the applicable order. We may suspend or terminate access for breach of these Terms or to address a security or legal risk.',
        'On termination, your right to access the Service ends, and Customer Data is handled as described in the Privacy Policy and the Data Processing Addendum — available for export in standard formats and then deleted. Provisions that by their nature should survive termination (including ownership, disclaimers, limitation of liability, and indemnification) will survive.',
      ],
    },
    {
      heading: 'Changes to the Service and these Terms',
      body: [
        'Because the Service is in beta, features may change frequently. We may also update these Terms; when we make a material change we will post the updated Terms here and revise the effective date. Your continued use of the Service after an update takes effect constitutes acceptance of the updated Terms.',
      ],
    },
    {
      heading: 'Governing law and disputes',
      body: [
        // COUNSEL_REVIEW: governing law + venue below are business facts (FILL);
        // counsel may add mandatory arbitration and a class-action waiver.
        `These Terms are governed by the laws of ${FILL.governingLaw}, without regard to its conflict-of-laws rules. The parties submit to the exclusive jurisdiction of the courts located in ${FILL.venue} for any dispute not subject to an agreed alternative process.`,
      ],
    },
    {
      heading: 'Contact',
      body: [
        `Questions about these Terms can be sent to ${FILL.contactEmail}, or by mail to ${FILL.entity}, ${FILL.address}.`,
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Privacy Policy. The security-measures section describes REAL controls
// (docs/13, docs/16); only the six business facts are placeholders.
// ---------------------------------------------------------------------------
export const privacyDoc: LegalDoc = {
  slug: 'privacy',
  title: 'Privacy Policy',
  subtitle: 'How Exit Blueprint collects, uses, and protects information.',
  lastUpdated: FILL.effectiveDate,
  sections: [
    {
      heading: 'Overview',
      body: [
        `This policy describes how ${FILL.entity}, operating the Exit Blueprint platform, handles information for the advisor firms that use it and the business owners they assess. Because the platform holds sensitive business and personal-financial information, data handling is a first-order design concern.`,
        'For the client data an advisor firm uploads about the companies and owners it advises, the firm is the controller of that data and Exit Blueprint processes it on the firm’s behalf, as described in our Data Processing Addendum.',
      ],
    },
    {
      heading: 'Information we collect',
      body: [
        'Account and identity information (names, email addresses, and firm/organization affiliation) needed to provision and authenticate users; business and assessment data submitted by advisors and owners (financial summaries, assessment answers, uploaded documents, and limited owner personal-financial-readiness inputs); billing contact and payment information when you subscribe to a paid plan; and usage information generated as the Service operates.',
        'We do not intentionally collect special categories of data (such as health information or government identifiers), and you agree not to submit them.',
      ],
    },
    {
      heading: 'How we use information',
      body: [
        'We use information to provide the Service — measuring exit readiness, diagnosing gaps, prescribing remediation, and generating reports and narrative from a firm’s own structured data; to authenticate users and secure the platform; to bill for paid plans; and to support, maintain, and improve the Service.',
        'We do not sell personal information. AI narrative generation uses report inputs only; it never computes or influences a readiness score, and information is not used to train third-party AI models.',
      ],
    },
    {
      heading: 'Sharing and sub-processors',
      body: [
        'We share information with the vetted third-party sub-processors that operate the platform (hosting, database and storage, authentication, billing, and AI narrative generation). Each is limited to the data needed for its function and is bound by data-protection obligations. The current list, with each provider’s purpose and data category, is on the Sub-processors page.',
        'We may also disclose information if required by law or valid legal process, to protect the rights, safety, or property of Exit Blueprint or others, or in connection with a corporate transaction such as a merger or acquisition (subject to this policy).',
      ],
    },
    {
      heading: 'Security measures',
      body: [
        // These are REAL, per docs/13-security-summary.md and docs/16.
        'Client data lives in a Postgres database (Supabase) where every domain table carries a firm identifier and is protected by row-level security, so a firm can read and write only its own records — enforced in the database, not just the application, and covered by an automated isolation test suite.',
        'Uploaded source documents are encrypted at rest with AES-256-GCM, with the encryption key supplied separately and never stored alongside the data; all traffic is over TLS. Source documents are served only through short-expiry signed URLs, never durable public links.',
        'Access is governed by roles (admin, advisor, reviewer, owner); multi-factor authentication is required for advisor and admin accounts; sessions are automatically signed out after 30 minutes of inactivity; and every read of a client document or report is written to an append-only audit log. Assessments are immutable snapshots — corrections create a new version rather than mutating history. No security measure is perfect, and we cannot guarantee absolute security.',
      ],
    },
    {
      heading: 'Data retention and deletion',
      body: [
        // COUNSEL_REVIEW: confirm these windows match the real Supabase backup
        // retention (docs/08 marks the exact window [confirm]).
        'We retain account and Customer Data for as long as your account is active and as needed to provide the Service and preserve a company’s readiness history.',
        'When you or your firm requests deletion, or after an account is terminated, we delete the affected records from the live database within thirty (30) days, and that data is purged from encrypted backups as those backups age out on a rolling retention window not exceeding sixty (60) days. We may retain limited information where required by law or to resolve disputes and enforce our agreements.',
      ],
    },
    {
      heading: 'Your rights',
      body: [
        'Depending on where you live, you may have rights to access, correct, delete, or port your personal information, or to object to or restrict certain processing. To exercise a right, contact us using the details below; we will respond as required by applicable law.',
        `Requests that concern a firm’s client data are generally directed to the advisor firm, which is the controller of that data. You can reach us at ${FILL.contactEmail}.`,
      ],
    },
    {
      heading: 'International data transfers',
      body: [
        'The Service is operated in the United States, and information is processed there. The Service is intended for use by US-based advisor firms; if you access it from outside the United States, you understand that information is transferred to and processed in the United States.',
      ],
    },
    {
      heading: 'Children’s privacy',
      body: [
        'The Service is a business tool intended for professional use and is not directed to children. We do not knowingly collect personal information from anyone under 18.',
      ],
    },
    {
      heading: 'Changes and contact',
      body: [
        'We may update this policy; when we make a material change we will post the updated policy here and revise the effective date.',
        `Questions or privacy requests can be sent to ${FILL.contactEmail}, or by mail to ${FILL.entity}, ${FILL.address}.`,
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Data Processing Addendum. References the real sub-processor list and security
// posture; only the six business facts are placeholders.
// ---------------------------------------------------------------------------
export const dpaDoc: LegalDoc = {
  slug: 'dpa',
  title: 'Data Processing Addendum',
  subtitle: 'Terms governing processing of personal data on behalf of customer firms.',
  lastUpdated: FILL.effectiveDate,
  sections: [
    {
      heading: 'Roles and scope',
      body: [
        `This Addendum forms part of the Terms of Service between the customer firm ("Customer") and ${FILL.entity} ("Exit Blueprint") and applies where Exit Blueprint processes personal data on the Customer’s behalf in providing the Service.`,
        'For the client data a Customer uploads about the companies and owners it advises, the Customer acts as the controller (or "business") and Exit Blueprint acts as the processor (or "service provider"). Where terms defined in an applicable data-protection law apply, they carry the meaning given in that law.',
      ],
    },
    {
      heading: 'Nature of processing and instructions',
      body: [
        'Exit Blueprint processes Customer personal data only to provide the Service — measuring exit readiness, generating reports and narrative from the Customer’s structured data, authenticating users, and supporting the platform — and on the Customer’s documented instructions, which include these Terms and the Customer’s use of the Service’s features. Exit Blueprint will inform the Customer if it believes an instruction violates applicable law.',
        'The categories of data subjects are the Customer’s personnel and the owners and personnel of the companies it advises; the categories of personal data are those the Customer chooses to submit. Processing continues for the duration of the Customer’s use of the Service.',
      ],
    },
    {
      heading: 'Confidentiality',
      body: [
        'Exit Blueprint ensures that personnel authorized to process Customer personal data are bound by appropriate obligations of confidentiality and access it only as needed to provide the Service.',
      ],
    },
    {
      heading: 'Sub-processors',
      body: [
        'The Customer authorizes Exit Blueprint to engage the sub-processors listed on the Sub-processors page to help deliver the Service. Each sub-processor is bound to data-protection obligations consistent with this Addendum, and Exit Blueprint remains responsible for their performance.',
        'When Exit Blueprint adds or replaces a sub-processor, it will update the Sub-processors page; for material changes it will endeavor to provide notice through the Service, and the Customer may object as described there.',
      ],
    },
    {
      heading: 'Security measures',
      body: [
        // REAL controls per docs/13 and docs/16.
        'Exit Blueprint maintains technical and organizational measures including: row-level security enforcing per-firm data isolation in the database; AES-256-GCM encryption of uploaded documents at rest with keys stored separately from the data; TLS in transit; short-expiry signed URLs for document delivery; role-based access control; required multi-factor authentication for advisor and admin accounts; automatic session timeout after inactivity; and append-only audit logging of document and report reads.',
        // COUNSEL_REVIEW: attach a definitive security schedule and current
        // certification status. SOC 2 is a tracked roadmap item (docs/16), not
        // yet held — do not represent it as complete.
        'These measures may evolve as the Service improves, provided the level of protection is not materially reduced. A formal third-party certification (such as SOC 2) is a roadmap item and is not represented as complete.',
      ],
    },
    {
      heading: 'Assistance with data-subject requests',
      body: [
        'Taking into account the nature of the processing, Exit Blueprint will provide reasonable assistance to help the Customer respond to requests from data subjects to exercise their rights. Where a request reaches Exit Blueprint directly and relates to a Customer’s data, Exit Blueprint will refer it to the Customer rather than respond on the Customer’s behalf.',
      ],
    },
    {
      heading: 'Personal-data-breach notification',
      body: [
        // COUNSEL_REVIEW: set the hard deadline. docs/16 targets 72 hours with a
        // ≤30-day contractual standard; "without undue delay" is used here so we
        // do not commit to a fixed hour we cannot yet guarantee operationally.
        'Exit Blueprint will notify the Customer without undue delay after confirming a personal-data breach affecting Customer Data, and will provide the information reasonably available to it to help the Customer meet its own notification obligations, together with reasonable cooperation to investigate and mitigate the breach.',
      ],
    },
    {
      heading: 'Return and deletion of data',
      body: [
        'On termination, and on request during the term, the Customer’s data is available for export in industry-standard formats (CSV/JSON, plus original documents). After export, or on the Customer’s deletion instruction, the data is deleted on the timeline described in the Privacy Policy — the firm-scoped schema makes a clean per-tenant export and deletion tractable — except for limited copies retained as required by law.',
      ],
    },
    {
      heading: 'Audits and cooperation',
      body: [
        'Exit Blueprint will make available information reasonably necessary to demonstrate compliance with this Addendum, including the security summary and sub-processor register, and will respond to reasonable written security questionnaires. Any on-site audit rights, frequency, and confidentiality conditions are as separately agreed in writing.',
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Sub-processors — the register (SUBPROCESSORS) renders as a table on the page.
// These sections frame it.
// ---------------------------------------------------------------------------
export const subprocessorsDoc: LegalDoc = {
  slug: 'subprocessors',
  title: 'Sub-processors',
  subtitle: 'Third parties that process data to help operate the Exit Blueprint platform.',
  lastUpdated: FILL.effectiveDate,
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
        'When we add or replace a sub-processor, we update this page. For material changes we will endeavor to provide notice through the Service, and customers may object as described in the Data Processing Addendum.',
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
