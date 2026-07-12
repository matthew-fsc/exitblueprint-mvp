// Maps a tier name to its fixed CSS class (which sets --tier) — shared by every
// component that colors by tier so the mapping lives in exactly one place.
import type { TierName } from '../../lib/tokens';

export const TIER_CLASS: Record<string, string> = {
  'Institutional Grade': 'tier-institutional',
  'Sale Ready': 'tier-sale-ready',
  'Needs Work': 'tier-needs-work',
  'High Risk': 'tier-high-risk',
  'Not Saleable (Yet)': 'tier-not-saleable',
};

export function tierClass(tier: TierName | string | null | undefined): string {
  return (tier && TIER_CLASS[tier]) || 'tier-needs-work';
}
