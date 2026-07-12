// Server-side HTML -> PDF for client-facing artifacts (F4). The branded delta
// report is rendered here, not with the browser's window.print(), so the output
// is deterministic and controlled. Chromium is driven headless via Playwright;
// the executable is resolved from EB_CHROMIUM_PATH when set (the managed
// environment preinstalls one), otherwise Playwright's own default.
import type { DeltaReportPayload } from './narrative';

export interface ReportBranding {
  display_name: string | null;
  logo_url: string | null;
  accent_color: string | null;
  report_from_line: string | null;
  footer_disclosure_md: string | null;
}

// Fixed tier colors (light), mirrored from src/lib/tokens.ts. PDFs are always
// light, so only the light values are needed here.
const TIER_COLOR: Record<string, string> = {
  'Institutional Grade': '#0e8f9e',
  'Sale Ready': '#2f9e44',
  'Needs Work': '#9a7d0a',
  'High Risk': '#e0670f',
  'Not Saleable (Yet)': '#c0362c',
};

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Minimal, safe markdown -> HTML for the narrative prose (headings, bold, lists,
// paragraphs). Matches the frontend renderer's supported subset.
function mdToHtml(md: string): string {
  const out: string[] = [];
  let inList = false;
  const closeList = () => {
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
  };
  const inline = (t: string) =>
    esc(t).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/_([^_]+)_/g, '<em>$1</em>');
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd();
    if (line.startsWith('- ')) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${inline(line.slice(2))}</li>`);
      continue;
    }
    closeList();
    if (line.startsWith('### ')) out.push(`<h3>${inline(line.slice(4))}</h3>`);
    else if (line.startsWith('## ')) out.push(`<h2>${inline(line.slice(3))}</h2>`);
    else if (line.startsWith('# ')) out.push(`<h1>${inline(line.slice(2))}</h1>`);
    else if (line.trim() === '') out.push('');
    else out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join('\n');
}

function deltaCell(delta: number | null): string {
  if (delta == null) return '<td class="num">—</td>';
  const up = delta >= 0;
  const arrow = up ? '▲' : '▼';
  const sign = up ? '+' : '−';
  const body = Math.abs(delta).toFixed(2).replace(/\.?0+$/, '');
  return `<td class="num ${up ? 'up' : 'down'}">${arrow} ${sign}${body}</td>`;
}

// The branded, print-first HTML for the delta report. Three logical pages via
// page-break-before on the section wrappers.
export function renderDeltaReportHtml(
  payload: DeltaReportPayload,
  narrativeMd: string,
  branding: ReportBranding | null,
): string {
  const firmName = branding?.display_name || 'Exit Blueprint';
  const accent = branding?.accent_color || '#1f7a52';
  const tier = payload.current.tier;
  const tierColor = TIER_COLOR[tier] || accent;
  const logo = branding?.logo_url
    ? `<img src="${esc(branding.logo_url)}" alt="${esc(firmName)}" class="logo" />`
    : `<span class="logo-fallback">${esc(firmName.charAt(0).toUpperCase())}</span>`;

  const headline =
    payload.mode === 'delta' && payload.prior
      ? `<div class="movement">
           <span class="prior">${payload.prior.drs}</span>
           <span class="arrow">→</span>
           <span class="current" style="color:${tierColor}">${payload.current.drs}</span>
           <span class="delta ${(payload.drs_delta ?? 0) >= 0 ? 'up' : 'down'}">${(payload.drs_delta ?? 0) >= 0 ? '▲ +' : '▼ −'}${Math.abs(payload.drs_delta ?? 0)}</span>
         </div>
         <p class="tierline">Now in the <strong style="color:${tierColor}">${esc(tier)}</strong> tier.</p>`
      : `<div class="movement"><span class="current" style="color:${tierColor}">${payload.current.drs}</span></div>
         <p class="tierline"><strong style="color:${tierColor}">${esc(tier)}</strong> tier — baseline.</p>`;

  const dimRows = payload.dimensions
    .map(
      (d) =>
        `<tr><td>${esc(d.name)}</td><td class="num">${d.prior ?? '—'}</td><td class="num">${d.current}</td>${deltaCell(d.delta)}</tr>`,
    )
    .join('');

  const gapsResolved = payload.gaps_resolved.length
    ? `<div class="gapcol"><h3>Cleared this period (${payload.gaps_resolved.length})</h3><ul>${payload.gaps_resolved.map((g) => `<li>${esc(g)}</li>`).join('')}</ul></div>`
    : '';
  const gapsOpen = payload.open_gaps.length
    ? `<div class="gapcol"><h3>Focus next period (${payload.open_gaps.length})</h3><ul>${payload.open_gaps.slice(0, 8).map((g) => `<li>${esc(g)}</li>`).join('')}</ul></div>`
    : '';

  const disclosure = branding?.footer_disclosure_md ? esc(branding.footer_disclosure_md) : '';
  const fromLine = branding?.report_from_line ? esc(branding.report_from_line) : '';

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: Letter; margin: 0.75in; }
    * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    body { font-family: -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #14251d; margin: 0; font-size: 12px; line-height: 1.5; }
    .brandbar { display: flex; align-items: center; justify-content: space-between; border-bottom: 2px solid ${accent}; padding-bottom: 12px; margin-bottom: 18px; }
    .brand { display: flex; align-items: center; gap: 10px; }
    .logo { height: 34px; max-width: 200px; object-fit: contain; }
    .logo-fallback { width: 34px; height: 34px; border-radius: 6px; background: ${accent}; color: #fff; font-weight: 800; display: inline-flex; align-items: center; justify-content: center; font-size: 18px; }
    .firm { font-size: 17px; font-weight: 700; color: #16352a; }
    .fromline { font-size: 11px; color: #566257; text-align: right; max-width: 260px; }
    h1 { font-size: 22px; margin: 0 0 4px; color: #16352a; }
    h2 { font-size: 15px; margin: 22px 0 8px; color: #16352a; border-bottom: 1px solid #dde3dd; padding-bottom: 4px; }
    h3 { font-size: 12.5px; margin: 0 0 6px; color: #16352a; }
    .meta { color: #566257; font-size: 11px; margin-bottom: 16px; }
    .movement { font-size: 46px; font-weight: 800; font-variant-numeric: tabular-nums; display: flex; align-items: baseline; gap: 14px; margin: 8px 0; }
    .movement .prior { color: #86928a; font-size: 30px; }
    .movement .arrow { color: #86928a; font-size: 26px; }
    .movement .delta { font-size: 16px; font-weight: 700; padding: 2px 8px; border-radius: 20px; }
    .delta.up, td.up { color: #1c6b33; } .delta.up { background: #e4f3e8; }
    .delta.down, td.down { color: #a5302a; } .delta.down { background: #f9e2e0; }
    .tierline { font-size: 13px; margin: 0 0 8px; }
    table { border-collapse: collapse; width: 100%; margin-top: 6px; font-size: 12px; }
    th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid #dde3dd; }
    th { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: #566257; }
    td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
    .gaps { display: flex; gap: 28px; }
    .gapcol { flex: 1; } .gapcol ul { margin: 4px 0 0; padding-left: 16px; } .gapcol li { margin-bottom: 3px; }
    .page2, .page3 { page-break-before: always; }
    .narrative p { margin: 6px 0; } .narrative ul { margin: 6px 0; padding-left: 18px; }
    .footer { position: fixed; bottom: 0.4in; left: 0.75in; right: 0.75in; border-top: 1px solid #dde3dd; padding-top: 6px; font-size: 9px; color: #86928a; display: flex; justify-content: space-between; gap: 16px; }
  </style></head><body>
    <div class="brandbar">
      <div class="brand">${logo}<span class="firm">${esc(firmName)}</span></div>
      ${fromLine ? `<div class="fromline">${fromLine}</div>` : ''}
    </div>

    <!-- Page 1: headline -->
    <h1>${payload.mode === 'delta' ? 'Progress this period' : 'Baseline readiness'} — ${esc(payload.company.name)}</h1>
    <div class="meta">${esc(payload.company.industry || '')}${payload.current.date ? ` · ${new Date(payload.current.date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}` : ''}${payload.engagement_target_window ? ` · target window ${esc(payload.engagement_target_window)}` : ''}</div>
    ${headline}
    <div class="narrative">${mdToHtml(narrativeMd)}</div>

    <!-- Page 2: dimension delta table + gaps -->
    <div class="page2">
      <h2>Where the business moved</h2>
      <table>
        <thead><tr><th>Business area</th><th class="num">Prior</th><th class="num">Current</th><th class="num">Change</th></tr></thead>
        <tbody>${dimRows}</tbody>
      </table>
      <h2>Diligence gaps</h2>
      <div class="gaps">${gapsResolved}${gapsOpen}</div>
    </div>

    <div class="footer">
      <span>${disclosure}</span>
      <span>Powered by Exit Blueprint</span>
    </div>
  </body></html>`;
}

export async function renderReportPdf(html: string): Promise<Buffer> {
  const { chromium } = await import('@playwright/test');
  const executablePath = process.env.EB_CHROMIUM_PATH || undefined;
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle' });
    return await page.pdf({ format: 'Letter', printBackground: true });
  } finally {
    await browser.close();
  }
}
