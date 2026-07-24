// Firm branding context (F1). Resolves the current advisor's firm branding and
// exposes it to any client-facing surface via useBrand(). When an accent color
// is set it derives and overrides the full coherent accent/button variable set
// for the subtree (see accentVars in color.ts), so ONE value rebrands accents,
// links, focus rings AND primary buttons — not just links. The advisor's firm
// is the face; ExitBlueprint is the engine.
import { createContext, useContext, type ReactNode } from 'react';
import { useAuth } from './auth';
import { useBranding, type BrandingRow } from './queries';
import { accentVars } from './color';
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

  // Derive the full accent-driven variable set (accent, accent-strong, and the
  // primary-button surface). Invalid/unparseable hex returns null → keep the
  // default forest tokens, so an unbranded firm looks exactly as before.
  const vars = accentVars(branding?.accent_color);
  const style = vars ? (vars as React.CSSProperties) : undefined;

  return (
    <BrandContext.Provider
      value={{ brand, branding: branding ?? null, firmName, loading: isLoading }}
    >
      {style ? <div style={style}>{children}</div> : children}
    </BrandContext.Provider>
  );
}

export const useBrand = () => useContext(BrandContext);
