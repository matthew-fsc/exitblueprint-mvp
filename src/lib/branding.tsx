// Firm branding context (F1). Resolves the current advisor's firm branding and
// exposes it to any client-facing surface via useBrand(). When an accent color
// is set it overrides --accent for the subtree, so one value rebrands every
// component that reads the token. The advisor's firm is the face; Exit
// Blueprint is the engine.
import { createContext, useContext, type ReactNode } from 'react';
import { useAuth } from './auth';
import { useBranding, type BrandingRow } from './queries';
import type { FirmBrand } from '../components/ui';

interface BrandState {
  brand: FirmBrand | null;
  branding: BrandingRow | null;
  firmName: string | null;
  loading: boolean;
}

const BrandContext = createContext<BrandState>({
  brand: null,
  branding: null,
  firmName: null,
  loading: false,
});

export function BrandingProvider({ children }: { children: ReactNode }) {
  const { profile, firmName } = useAuth();
  const { data: branding, isLoading } = useBranding(profile?.firm_id ?? undefined);

  const brand: FirmBrand | null = branding
    ? {
        displayName: branding.display_name || firmName,
        logoUrl: branding.logo_url,
        accentColor: branding.accent_color,
      }
    : firmName
      ? { displayName: firmName, logoUrl: null, accentColor: null }
      : null;

  const style = branding?.accent_color
    ? ({ ['--accent' as string]: branding.accent_color } as React.CSSProperties)
    : undefined;

  return (
    <BrandContext.Provider
      value={{ brand, branding: branding ?? null, firmName, loading: isLoading }}
    >
      {style ? <div style={style}>{children}</div> : children}
    </BrandContext.Provider>
  );
}

export const useBrand = () => useContext(BrandContext);
