// Renders a firm's identity — logo if present, otherwise an initial mark +
// name. The advisor's firm is the face on every client-facing surface (F1
// positioning rule); Exit Blueprint appears only as a discreet "Powered by".
export interface FirmBrand {
  displayName: string | null;
  logoUrl: string | null;
  accentColor?: string | null;
}

export function FirmMark({
  brand,
  fallbackName,
  poweredBy = false,
}: {
  brand?: FirmBrand | null;
  fallbackName?: string | null;
  poweredBy?: boolean;
}) {
  const name = brand?.displayName || fallbackName || 'Exit Blueprint';
  const initial = name.trim().charAt(0).toUpperCase() || 'E';
  return (
    <span className="firm-mark">
      {brand?.logoUrl ? (
        <img className="firm-mark-logo" src={brand.logoUrl} alt={name} />
      ) : (
        <span className="firm-mark-fallback" aria-hidden>
          {initial}
        </span>
      )}
      <span className="firm-mark-name">{name}</span>
      {poweredBy && <span className="powered-by">Powered by Exit Blueprint</span>}
    </span>
  );
}
