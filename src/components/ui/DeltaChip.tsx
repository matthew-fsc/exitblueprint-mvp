import { fmtDelta } from '../../lib/format';

// Signed delta with a sign-aware color and tabular numerals. `goodWhenUp`
// flips the color meaning for metrics where fewer is better (gap counts).
export function DeltaChip({
  value,
  digits = 1,
  goodWhenUp = true,
}: {
  value: number | null | undefined;
  digits?: number;
  goodWhenUp?: boolean;
}) {
  const { text, sign } = fmtDelta(value, digits);
  if (sign === 'flat') return <span className="delta delta-chip delta-flat">{text}</span>;
  const good = (sign === 'up') === goodWhenUp;
  return <span className={`delta delta-chip ${good ? 'delta-up' : 'delta-down'}`}>{text}</span>;
}
