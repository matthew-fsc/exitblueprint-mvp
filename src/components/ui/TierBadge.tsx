import { tierClass } from './tier';

// A tier label + its fixed dot color. Color is never the sole cue — the tier
// name is always present (dataviz: status ships with a label).
export function TierBadge({
  tier,
  size = 'md',
}: {
  tier: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  return (
    <span className={`tier-badge tier-badge-${size} ${tierClass(tier)}`}>{tier}</span>
  );
}
