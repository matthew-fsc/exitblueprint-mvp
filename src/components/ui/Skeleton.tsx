// Loading placeholder sized to the content it stands in for, so there is no
// layout shift on load (spec §7).
export function Skeleton({
  width = '100%',
  height = '1rem',
  radius,
  className = '',
}: {
  width?: string | number;
  height?: string | number;
  radius?: string | number;
  className?: string;
}) {
  return (
    <span
      className={`skeleton ${className}`.trim()}
      style={{ width, height, borderRadius: radius }}
      aria-hidden
    />
  );
}

// A stack of text-line skeletons.
export function SkeletonLines({ lines = 3 }: { lines?: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }} aria-busy>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} height="0.85rem" width={i === lines - 1 ? '60%' : '100%'} />
      ))}
    </div>
  );
}
