import { BRAND } from '../../lib/brand';

// The ExitBlueprint logomark + wordmark. The mark is three ascending columns —
// the rising-readiness / DRS-trajectory motif that runs through the product —
// drawn in currentColor so a container can spend the accent on it (the one place
// the register says accent belongs) or mute it for a discreet endorsement.
//
// This is the engine's own mark. On client-facing surfaces the advisor's firm is
// the face (FirmMark); this appears as the app chrome and the "Powered by" line.

export function BrandLogomark({
  size = 20,
  boxed = false,
  className,
  title = BRAND.name,
}: {
  size?: number;
  // Boxed = the app-icon lockup (rounded brand tile, mark reversed out). Unboxed
  // = the inline glyph that inherits currentColor for the wordmark.
  boxed?: boolean;
  className?: string;
  title?: string;
}) {
  const bars = (
    <>
      <rect x="3" y="14" width="4.5" height="7" rx="1.5" />
      <rect x="9.75" y="9" width="4.5" height="12" rx="1.5" />
      <rect x="16.5" y="4" width="4.5" height="17" rx="1.5" />
    </>
  );
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label={title}
      focusable="false"
    >
      {boxed ? (
        <>
          <rect width="24" height="24" rx="5.5" fill="var(--brand)" />
          <g fill="var(--on-brand)">{bars}</g>
        </>
      ) : (
        <g fill="currentColor">{bars}</g>
      )}
    </svg>
  );
}

// The full lockup: mark + "ExitBlueprint", with the internal capitalization made
// visible by weighting "Exit" heavier than "Blueprint" (a weight lockup, not a
// color one — the accent stays on the mark, per the institutional register).
export function BrandWordmark({
  size = 'md',
  className = '',
}: {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const px = size === 'lg' ? 28 : size === 'sm' ? 16 : 22;
  return (
    <span className={`brand-wordmark brand-wordmark-${size} ${className}`.trim()}>
      <BrandLogomark className="brand-wordmark-mark" size={px} />
      <span className="brand-wordmark-text">
        <b>Exit</b>Blueprint
      </span>
    </span>
  );
}
