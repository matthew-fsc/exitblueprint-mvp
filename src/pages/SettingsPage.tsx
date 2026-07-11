import { useEffect, useState, type ChangeEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';
import { qk, useBranding } from '../lib/queries';
import { Card, FirmMark, PageHeader, TierBadge, useToast } from '../components/ui';

// Validate a CSS hex color (#rgb or #rrggbb).
const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export default function SettingsPage() {
  const { profile, firmName } = useAuth();
  const firmId = profile?.firm_id ?? undefined;
  const { data: branding, isLoading } = useBranding(firmId);
  const qc = useQueryClient();
  const toast = useToast();

  const [displayName, setDisplayName] = useState('');
  const [accent, setAccent] = useState('');
  const [logoUrl, setLogoUrl] = useState('');
  const [fromLine, setFromLine] = useState('');
  const [disclosure, setDisclosure] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (branding) {
      setDisplayName(branding.display_name ?? '');
      setAccent(branding.accent_color ?? '');
      setLogoUrl(branding.logo_url ?? '');
      setFromLine(branding.report_from_line ?? '');
      setDisclosure(branding.footer_disclosure_md ?? '');
    } else if (branding === null && firmName) {
      setDisplayName(firmName);
    }
  }, [branding, firmName]);

  const accentValid = accent === '' || HEX.test(accent);

  // Logo upload: store as a data URL in logo_url so it works without a
  // configured storage bucket (dev stack). Production can swap this for a
  // Supabase Storage upload and store the public URL instead.
  const onLogoFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 400_000) {
      setError('Logo must be under 400 KB. Use an SVG or a small PNG.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setLogoUrl(String(reader.result));
    reader.readAsDataURL(file);
  };

  const save = async () => {
    if (!firmId) return;
    if (!accentValid) {
      setError('Accent color must be a hex value like #1f7a52.');
      return;
    }
    setSaving(true);
    setError(null);
    const { error } = await supabase
      .from('firm_branding')
      .upsert(
        {
          firm_id: firmId,
          display_name: displayName || null,
          accent_color: accent || null,
          logo_url: logoUrl || null,
          report_from_line: fromLine || null,
          footer_disclosure_md: disclosure || null,
        },
        { onConflict: 'firm_id' },
      );
    setSaving(false);
    if (error) {
      setError(error.message);
      return;
    }
    qc.invalidateQueries({ queryKey: qk.branding(firmId) });
    toast.show('Branding saved', 'good');
  };

  const previewBrand = {
    displayName: displayName || firmName,
    logoUrl: logoUrl || null,
    accentColor: accentValid && accent ? accent : null,
  };

  return (
    <div>
      <PageHeader
        title="Firm branding"
        subtitle="Your firm is the face on every client-facing report and portal. Exit Blueprint stays in the background."
        crumbs={[{ label: 'Clients', to: '/' }, { label: 'Settings' }]}
      />

      {error && <p className="form-error">{error}</p>}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,20rem)', gap: '1.25rem', alignItems: 'start' }} className="settings-grid">
        <Card pad="lg">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <label className="field">
              <span className="field-label">Display name</span>
              <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Cascade Wealth Partners" />
            </label>

            <label className="field">
              <span className="field-label">Report from line</span>
              <input value={fromLine} onChange={(e) => setFromLine(e.target.value)} placeholder="Prepared by Jane Doe, CFP®, Cascade Wealth Partners" />
            </label>

            <label className="field">
              <span className="field-label">Accent color</span>
              <span className="control-row">
                <input
                  type="color"
                  value={accentValid && accent ? (accent.length === 4 ? accent : accent) : '#1f7a52'}
                  onChange={(e) => setAccent(e.target.value)}
                  style={{ width: '3rem', height: '2.4rem', padding: 2 }}
                  aria-label="Accent color picker"
                />
                <input
                  value={accent}
                  onChange={(e) => setAccent(e.target.value)}
                  placeholder="#1f7a52"
                  style={{ maxWidth: '9rem' }}
                  aria-invalid={!accentValid}
                />
                {!accentValid && <span className="form-error">invalid hex</span>}
              </span>
            </label>

            <label className="field">
              <span className="field-label">Logo</span>
              <input type="file" accept="image/png,image/svg+xml,image/jpeg" onChange={onLogoFile} />
              <span className="field-hint">PNG or SVG, under 400 KB. Or paste a URL below.</span>
              <input value={logoUrl.startsWith('data:') ? '' : logoUrl} onChange={(e) => setLogoUrl(e.target.value)} placeholder="https://…/logo.svg" />
              {logoUrl && (
                <button className="linkish" type="button" onClick={() => setLogoUrl('')} style={{ alignSelf: 'flex-start' }}>
                  Remove logo
                </button>
              )}
            </label>

            <label className="field">
              <span className="field-label">Footer disclosure</span>
              <textarea
                rows={4}
                value={disclosure}
                onChange={(e) => setDisclosure(e.target.value)}
                placeholder="Compliance disclosure shown at the foot of every client-facing document."
              />
            </label>

            <div>
              <button onClick={save} disabled={saving || isLoading || !firmId}>
                {saving ? 'Saving…' : 'Save branding'}
              </button>
            </div>
          </div>
        </Card>

        <Card pad="lg">
          <span className="stat-block-label">Live preview</span>
          <div style={{ marginTop: '0.9rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div style={accentValid && accent ? ({ ['--accent' as string]: accent } as React.CSSProperties) : undefined}>
              <FirmMark brand={previewBrand} />
              <p className="ui-pageheader-sub" style={{ marginTop: '0.5rem' }}>{fromLine || 'Prepared by your firm'}</p>
              <div style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <TierBadge tier="Sale Ready" />
                <button style={{ background: 'var(--accent)' }}>Accent button</button>
              </div>
              {disclosure && (
                <p className="powered-by" style={{ marginTop: '0.9rem' }}>{disclosure}</p>
              )}
              <p className="powered-by" style={{ marginTop: '0.5rem' }}>Powered by Exit Blueprint</p>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
