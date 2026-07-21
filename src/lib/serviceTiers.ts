// Service-tier catalog: the named service levels a firm picks during first-run
// onboarding (stored on firm_service_tier; see 20260721000600). This is the
// firm's scope/positioning choice, not the Stripe billing plan and not the
// computed DRS readiness tiers — it lives in one place so the onboarding picker
// and any later surface read the same labels and copy.
//
// The codes here MUST match the firm_service_tier_code check constraint.
//
// Direction (Matthew, 2026-07-21): the tier is PER-FIRM and standalone for now,
// but is expected to eventually route to Stripe — i.e. converge with the billing
// plan catalog (plans: solo/practice/firm) so the selected tier becomes the thing
// the firm pays for. When that slice lands, reconcile this catalog with `plans`
// (or point firm_service_tier at a plan code) rather than keeping two parallel
// lists. The advisor-plans-vs-firm-plans distinction is deferred to that work.

export type ServiceTierCode = 'essentials' | 'standard' | 'premium';

export interface ServiceTier {
  code: ServiceTierCode;
  name: string;
  // One-line positioning shown under the name in the picker.
  tagline: string;
  // What the tier covers, in the advisor's language. Copy only — no feature gate
  // is wired to these (entitlements live in the billing plan catalog).
  points: string[];
}

export const SERVICE_TIERS: ServiceTier[] = [
  {
    code: 'essentials',
    name: 'Essentials',
    tagline: 'A baseline readiness read for owners early in the runway.',
    points: [
      'Deal Readiness Score (DRS) baseline and re-assessments',
      'Gap diagnosis with the remediation roadmap',
      'Owner portal access',
    ],
  },
  {
    code: 'standard',
    name: 'Standard',
    tagline: 'Guided remediation for owners actively closing gaps.',
    points: [
      'Everything in Essentials',
      'Valuation and EBITDA recast',
      'Buyer lens and document data room',
    ],
  },
  {
    code: 'premium',
    name: 'Premium',
    tagline: 'Full pre-deal preparation with verified financials.',
    points: [
      'Everything in Standard',
      'Financial verification and delta reports',
      'Priority support',
    ],
  },
];

export function serviceTier(code: string | null | undefined): ServiceTier | null {
  return SERVICE_TIERS.find((t) => t.code === code) ?? null;
}
