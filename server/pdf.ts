// Server-side HTML -> PDF for client-facing artifacts. Both the owner report
// and the delta report are rendered here on one institutional document
// scaffold — a full-bleed branded cover, a score-ring hero, dimension bar
// tables, and a running footer with page numbers — so the output reads as a
// designed report, not a browser print-out. Chromium is driven headless via
// Playwright; the executable is resolved from EB_CHROMIUM_PATH, then the
// managed browser cache, then common system locations (see resolveChromium).
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DeltaReportPayload } from './narrative';
import { consensus, tierMeaning } from '../shared/scoring/interpret';

export interface ReportBranding {
  display_name: string | null;
  logo_url: string | null;
  accent_color: string | null;
  report_from_line: string | null;
  footer_disclosure_md: string | null;
}

// Fixed tier colors (light) mirrored from src/lib/tokens.ts. PDFs are always light.
const TIER_COLOR: Record<string, string> = {
  'Institutional Grade': '#0e8f9e',
  'Sale Ready': '#2f9e44',
  'Needs Work': '#9a7d0a',
  'High Risk': '#e0670f',
  'Not Saleable (Yet)': '#c0362c',
};

const INK = '#14251d';
const BRAND = '#16352a';
const MUTED = '#6b756c';
const HAIR = '#dde3dd';
const TRACK = '#e8ece8';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const fmtDate = (d: string | null) =>
  d ? new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '';

// Minimal, safe markdown -> HTML for the narrative prose.
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
    else if (line.startsWith('# ')) continue; // title shown in the cover
    else if (line.trim() === '') out.push('');
    else out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join('\n');
}

function dimBandColor(score: number): string {
  return score >= 75 ? '#2f9e44' : score >= 55 ? '#1f7a52' : score >= 40 ? '#b07d05' : '#c0362c';
}

function deltaBadge(delta: number | null): string {
  if (delta == null) return '<span class="mut">—</span>';
  const up = delta >= 0;
  const body = Math.abs(delta).toFixed(2).replace(/\.?0+$/, '');
  return `<span class="delta ${up ? 'up' : 'down'}">${up ? '▲ +' : '▼ −'}${body}</span>`;
}

// ---- shared scaffolding -----------------------------------------------------

function logoHtml(branding: ReportBranding | null, firmName: string, accent: string): string {
  return branding?.logo_url
    ? `<img class="logo" src="${esc(branding.logo_url)}" alt="${esc(firmName)}" />`
    : `<span class="logo-fallback" style="background:${accent}">${esc(firmName.charAt(0).toUpperCase())}</span>`;
}

function coverBand(opts: {
  firmName: string;
  accent: string;
  logo: string;
  fromLine: string;
  kicker: string;
  title: string;
  meta: string;
}): string {
  return `
  <div class="cover">
    <div class="cover-top">
      <div class="brand">${opts.logo}<span class="firm">${esc(opts.firmName)}</span></div>
      ${opts.fromLine ? `<div class="fromline">${esc(opts.fromLine)}</div>` : ''}
    </div>
    <div class="cover-title">
      <div class="kicker">${esc(opts.kicker)}</div>
      <h1>${esc(opts.title)}</h1>
      <div class="meta">${opts.meta}</div>
    </div>
  </div>`;
}

function scoreRing(score: number, tier: string, caption: string): string {
  const color = TIER_COLOR[tier] || '#1f7a52';
  const pct = Math.max(0, Math.min(100, score));
  return `
    <div class="ring" style="background: conic-gradient(${color} ${pct}%, ${TRACK} 0)">
      <div class="ring-inner">
        <span class="ring-num">${Number.isInteger(score) ? score : score.toFixed(1)}</span>
        <span class="ring-cap">${esc(caption)}</span>
      </div>
    </div>`;
}

function tierChip(tier: string): string {
  const color = TIER_COLOR[tier] || '#1f7a52';
  return `<span class="tier-chip" style="color:${color};border-color:${color}"><span class="dot" style="background:${color}"></span>${esc(tier)}</span>`;
}

function dimTable(
  dims: { name: string; current: number; prior?: number | null; delta?: number | null }[],
  showDelta: boolean,
): string {
  const rows = dims
    .map((d) => {
      const bar = `<span class="bar"><span class="bar-fill" style="width:${Math.max(0, Math.min(100, d.current))}%;background:${dimBandColor(d.current)}"></span></span>`;
      const deltaCol = showDelta ? `<td class="num">${deltaBadge(d.delta ?? null)}</td>` : '';
      const priorCol = showDelta ? `<td class="num mut">${d.prior ?? '—'}</td>` : '';
      return `<tr><td class="dname">${esc(d.name)}</td><td class="barcell">${bar}</td>${priorCol}<td class="num strong">${d.current}</td>${deltaCol}</tr>`;
    })
    .join('');
  const head = showDelta
    ? `<tr><th>Business area</th><th></th><th class="num">Prior</th><th class="num">Current</th><th class="num">Change</th></tr>`
    : `<tr><th>Business area</th><th></th><th class="num">Score</th></tr>`;
  return `<table class="dimtable"><thead>${head}</thead><tbody>${rows}</tbody></table>`;
}

function institutionalCss(accent: string): string {
  return `
    * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    html, body { margin: 0; }
    body { font-family: -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: ${INK}; font-size: 11.5px; line-height: 1.55; }
    .pad { padding: 0 0.72in; }
    h1 { font-size: 25px; letter-spacing: -0.01em; margin: 0; color: #fff; }
    h2 { font-size: 14px; color: ${BRAND}; margin: 24px 0 10px; padding-bottom: 5px; border-bottom: 1px solid ${HAIR}; letter-spacing: -0.01em; }
    h3 { font-size: 12px; color: ${BRAND}; margin: 0 0 5px; }
    p { margin: 7px 0; }
    .mut, .mut td { color: ${MUTED}; }
    .strong { font-weight: 700; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }

    /* cover */
    .cover { background: linear-gradient(180deg, ${BRAND} 0%, #12281f 100%); color: #fff; padding: 0.5in 0.72in 0.42in; }
    .cover-top { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding-bottom: 22px; border-bottom: 1px solid rgba(255,255,255,0.16); }
    .brand { display: flex; align-items: center; gap: 10px; }
    .logo { height: 30px; max-width: 190px; object-fit: contain; background:#fff; border-radius:4px; padding:2px 4px; }
    .logo-fallback { width: 30px; height: 30px; border-radius: 6px; color: #fff; font-weight: 800; display: inline-flex; align-items: center; justify-content: center; font-size: 16px; border: 1px solid rgba(255,255,255,0.5); }
    .firm { font-size: 15px; font-weight: 700; color: #fff; }
    .fromline { font-size: 10px; color: rgba(255,255,255,0.75); text-align: right; max-width: 250px; }
    .cover-title { padding-top: 22px; }
    .kicker { font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: ${accent}; font-weight: 700; filter: brightness(1.7); margin-bottom: 7px; }
    .cover-title .meta { color: rgba(255,255,255,0.8); font-size: 11px; margin-top: 8px; }

    /* hero */
    .hero { display: flex; align-items: center; gap: 26px; margin: 22px 0 8px; }
    .ring { width: 128px; height: 128px; border-radius: 50%; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .ring-inner { width: 100px; height: 100px; border-radius: 50%; background: #fff; display: flex; flex-direction: column; align-items: center; justify-content: center; }
    .ring-num { font-size: 33px; font-weight: 800; color: ${BRAND}; font-variant-numeric: tabular-nums; line-height: 1; }
    .ring-cap { font-size: 8px; letter-spacing: 0.08em; text-transform: uppercase; color: ${MUTED}; margin-top: 3px; }
    .hero-side { flex: 1; }
    .tier-chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px; border-radius: 999px; font-weight: 700; font-size: 12px; background: #fff; border: 1px solid; }
    .tier-chip .dot { width: 7px; height: 7px; border-radius: 999px; }
    .hero-line { font-size: 12.5px; color: ${INK}; margin: 10px 0 0; }
    .subscores { display: flex; gap: 20px; margin-top: 12px; }
    .subscore .k { font-size: 8.5px; letter-spacing: 0.07em; text-transform: uppercase; color: ${MUTED}; }
    .subscore .v { font-size: 18px; font-weight: 800; color: ${BRAND}; font-variant-numeric: tabular-nums; }

    /* movement (delta) */
    .movement { font-size: 44px; font-weight: 800; font-variant-numeric: tabular-nums; display: flex; align-items: baseline; gap: 14px; }
    .movement .prior { color: ${MUTED}; font-size: 28px; }
    .movement .arrow { color: ${MUTED}; font-size: 24px; }
    .delta { font-size: 13px; font-weight: 700; padding: 2px 9px; border-radius: 999px; }
    .delta.up { color: #1c6b33; background: #e4f3e8; }
    .delta.down { color: #a5302a; background: #f9e2e0; }

    /* consensus callout */
    .consensus { background: #f3f7f4; border-left: 3px solid ${accent}; border-radius: 6px; padding: 12px 16px; margin: 16px 0 6px; font-size: 12px; line-height: 1.6; }
    .consensus .lbl { font-size: 9px; letter-spacing: 0.1em; text-transform: uppercase; color: ${MUTED}; font-weight: 700; display: block; margin-bottom: 4px; }

    /* tables */
    table { border-collapse: collapse; width: 100%; margin-top: 6px; }
    th { font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em; color: ${MUTED}; text-align: left; padding: 6px 10px; border-bottom: 1.5px solid ${HAIR}; }
    td { padding: 8px 10px; border-bottom: 1px solid ${HAIR}; font-size: 11.5px; }
    .dimtable .dname { font-weight: 600; width: 34%; }
    .dimtable .barcell { width: 34%; }
    .bar { display: block; height: 7px; background: ${TRACK}; border-radius: 999px; overflow: hidden; }
    .bar-fill { display: block; height: 100%; border-radius: 999px; }

    /* gap lists */
    .gaps { display: flex; gap: 30px; margin-top: 6px; }
    .gapcol { flex: 1; }
    .gapcol ul { margin: 6px 0 0; padding-left: 16px; }
    .gapcol li { margin-bottom: 4px; }
    .gap-item { margin-bottom: 9px; }
    .sev { display: inline-block; font-size: 8.5px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.04em; padding: 1px 6px; border-radius: 4px; margin-right: 7px; vertical-align: middle; }
    .sev.critical { background: #f9e2e0; color: #a5302a; }
    .sev.high { background: #fbe8da; color: #a04a12; }
    .sev.med { background: #f7efd6; color: #855e05; }
    .sev.low { background: #eef1ee; color: #576259; }
    .gap-item .why { color: ${MUTED}; font-size: 11px; }

    .narrative p { margin: 7px 0; }
    .narrative ul { margin: 7px 0; padding-left: 18px; }
    .page-break { page-break-before: always; }
    .disclosure { margin-top: 22px; padding-top: 10px; border-top: 1px solid ${HAIR}; font-size: 9px; color: ${MUTED}; line-height: 1.5; }
  `;
}

function docShell(accent: string, coverAndBody: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${institutionalCss(accent)}</style></head><body>${coverAndBody}</body></html>`;
}

// ---- delta report -----------------------------------------------------------

export function renderDeltaReportHtml(
  payload: DeltaReportPayload,
  narrativeMd: string,
  branding: ReportBranding | null,
): string {
  const firmName = branding?.display_name || 'Exit Blueprint';
  const accent = branding?.accent_color || '#1f7a52';
  const tier = payload.current.tier;
  const isDelta = payload.mode === 'delta' && payload.prior != null;

  const cover = coverBand({
    firmName,
    accent,
    logo: logoHtml(branding, firmName, accent),
    fromLine: branding?.report_from_line || '',
    kicker: isDelta ? 'Quarterly progress review' : 'Baseline readiness report',
    title: payload.company.name,
    meta: `${esc(payload.company.industry || '')}${payload.current.date ? ` &middot; ${fmtDate(payload.current.date)}` : ''}${payload.engagement_target_window ? ` &middot; target window ${esc(payload.engagement_target_window)}` : ''}`,
  });

  const con = consensus({
    drsScore: payload.current.drs,
    drsTier: payload.current.tier,
    oriScore: payload.current.ori,
    dimensions: payload.dimensions.map((d) => ({ code: d.name, name: d.name, score: d.current })),
    firedGaps: payload.open_gaps.map(() => ({ severity: 'high' })),
  });

  const hero = isDelta
    ? `<div class="movement"><span class="prior">${payload.prior!.drs}</span><span class="arrow">→</span><span style="color:${TIER_COLOR[tier]}">${payload.current.drs}</span>${deltaBadge(payload.drs_delta)}</div>
       <p class="hero-line">Now in the ${tierChip(tier)} tier — ${esc(tierMeaning(tier))}.</p>`
    : `<div class="hero">${scoreRing(payload.current.drs, tier, 'DRS / 100')}<div class="hero-side">${tierChip(tier)}<p class="hero-line">${esc(con.headline)}</p></div></div>`;

  const gapsResolved = payload.gaps_resolved.length
    ? `<div class="gapcol"><h3>Cleared this period (${payload.gaps_resolved.length})</h3><ul>${payload.gaps_resolved.map((g) => `<li>${esc(g)}</li>`).join('')}</ul></div>`
    : '';
  const gapsOpen = payload.open_gaps.length
    ? `<div class="gapcol"><h3>Focus next period (${payload.open_gaps.length})</h3><ul>${payload.open_gaps.slice(0, 8).map((g) => `<li>${esc(g)}</li>`).join('')}</ul></div>`
    : '';

  const disclosure = branding?.footer_disclosure_md
    ? `<div class="disclosure">${esc(branding.footer_disclosure_md)}</div>`
    : '';

  const body = `
  <div class="pad">
    ${hero}
    <div class="consensus"><span class="lbl">Bottom line</span>${esc(con.bottomLine)}</div>
    <div class="narrative">${mdToHtml(narrativeMd)}</div>

    <div class="page-break"></div>
    <h2>Where the business ${isDelta ? 'moved' : 'stands'}</h2>
    ${dimTable(payload.dimensions, isDelta)}
    ${gapsResolved || gapsOpen ? `<h2>Diligence gaps</h2><div class="gaps">${gapsResolved}${gapsOpen}</div>` : ''}
    ${disclosure}
  </div>`;

  return docShell(accent, cover + body);
}

// ---- owner report -----------------------------------------------------------

export interface OwnerReportData {
  companyName: string;
  industry: string | null;
  targetWindow: string | null;
  date: string | null;
  drs: number;
  tier: string;
  ori: number;
  dimensions: { name: string; score: number }[];
  topGaps: { name: string; severity: string; playbook: string | null }[];
  flags: string[];
}

export function renderOwnerReportHtml(
  data: OwnerReportData,
  narrativeMd: string,
  branding: ReportBranding | null,
): string {
  const firmName = branding?.display_name || 'Exit Blueprint';
  const accent = branding?.accent_color || '#1f7a52';

  const cover = coverBand({
    firmName,
    accent,
    logo: logoHtml(branding, firmName, accent),
    fromLine: branding?.report_from_line || '',
    kicker: 'Exit readiness report',
    title: data.companyName,
    meta: `${esc(data.industry || '')}${data.date ? ` &middot; ${fmtDate(data.date)}` : ''}${data.targetWindow ? ` &middot; target window ${esc(data.targetWindow)}` : ''}`,
  });

  const con = consensus({
    drsScore: data.drs,
    drsTier: data.tier,
    oriScore: data.ori,
    dimensions: data.dimensions.map((d) => ({ code: d.name, name: d.name, score: d.score })),
    firedGaps: data.topGaps.map((g) => ({ severity: g.severity })),
  });

  const hero = `
  <div class="hero">
    ${scoreRing(data.drs, data.tier, 'DRS / 100')}
    <div class="hero-side">
      ${tierChip(data.tier)}
      <p class="hero-line">${esc(con.headline)}</p>
      <div class="subscores">
        <div class="subscore"><div class="k">Owner readiness</div><div class="v">${data.ori}</div></div>
        <div class="subscore"><div class="k">Business readiness</div><div class="v">${data.drs}</div></div>
      </div>
    </div>
  </div>`;

  const gapsHtml = data.topGaps.length
    ? data.topGaps
        .map(
          (g) =>
            `<div class="gap-item"><span class="sev ${g.severity}">${esc(g.severity)}</span><strong>${esc(g.name)}</strong>${g.playbook ? `<div class="why">${esc(g.playbook)}</div>` : ''}</div>`,
        )
        .join('')
    : '<p class="mut">No gaps were flagged in this assessment.</p>';

  const flagsHtml = data.flags.length
    ? `<h2>Worth noting</h2><ul>${data.flags.map((f) => `<li>${esc(f)} — scored conservatively until it is measured.</li>`).join('')}</ul>`
    : '';

  const disclosure = branding?.footer_disclosure_md
    ? `<div class="disclosure">${esc(branding.footer_disclosure_md)}</div>`
    : '';

  const body = `
  <div class="pad">
    ${hero}
    <div class="consensus"><span class="lbl">Bottom line</span>${esc(con.bottomLine)}</div>

    <h2>The six business areas</h2>
    ${dimTable(data.dimensions.map((d) => ({ name: d.name, current: d.score })), false)}

    <div class="page-break"></div>
    <h2>What buyers would flag first</h2>
    ${gapsHtml}
    ${flagsHtml}

    <h2>In the owner’s words</h2>
    <div class="narrative">${mdToHtml(narrativeMd)}</div>
    ${disclosure}
  </div>`;

  return docShell(accent, cover + body);
}

// ---- CIM (Confidential Information Memorandum) -------------------------------

export interface CimReportData {
  companyName: string;
  industry: string | null;
  date: string | null;
}

// Buyer-facing marketing document. The narrative markdown already carries the
// full sectioned body (Investment Highlights … The Opportunity); the PDF wraps
// it in the same institutional cover + footer as the other reports, with a
// confidential kicker. No score ring or gap tables — this is not a diagnostic.
export function renderCimReportHtml(
  data: CimReportData,
  narrativeMd: string,
  branding: ReportBranding | null,
): string {
  const firmName = branding?.display_name || 'Exit Blueprint';
  const accent = branding?.accent_color || '#1f7a52';

  const cover = coverBand({
    firmName,
    accent,
    logo: logoHtml(branding, firmName, accent),
    fromLine: branding?.report_from_line || '',
    kicker: 'Confidential Information Memorandum',
    title: data.companyName,
    meta: `${esc(data.industry || '')}${data.date ? ` &middot; ${fmtDate(data.date)}` : ''}`,
  });

  const disclosure = branding?.footer_disclosure_md
    ? `<div class="disclosure">${esc(branding.footer_disclosure_md)}</div>`
    : '';

  const body = `
  <div class="pad">
    <div class="narrative">${mdToHtml(narrativeMd)}</div>
    ${disclosure}
  </div>`;

  return docShell(accent, cover + body);
}

// ---- renderer ---------------------------------------------------------------

// Scan one Playwright browser-cache dir for a Chromium binary, newest revision
// first. Handles the per-OS on-disk layouts (chrome-linux / chrome-mac /
// chrome-win) so a locally `npx playwright install`ed browser is found too.
function findChromiumInCache(base: string): string | undefined {
  let entries: string[];
  try {
    entries = readdirSync(base);
  } catch {
    return undefined; // dir absent
  }
  // Prefer a full Chromium build, newest first.
  const fullRels = [
    ['chrome-linux', 'chrome'],
    ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
    ['chrome-win', 'chrome.exe'],
  ];
  for (const d of entries.filter((e) => e.startsWith('chromium-')).sort().reverse()) {
    for (const rel of fullRels) {
      const p = join(base, d, ...rel);
      if (existsSync(p)) return p;
    }
  }
  // Fall back to a headless-shell build (layout varies by version/OS).
  const shellRels = [
    ['chrome-linux', 'headless_shell'],
    ['chrome-headless-shell-linux64', 'chrome-headless-shell'],
    ['chrome-mac', 'chrome-headless-shell'],
    ['chrome-win', 'chrome-headless-shell.exe'],
  ];
  for (const d of entries.filter((e) => e.startsWith('chromium_headless_shell')).sort().reverse()) {
    for (const rel of shellRels) {
      const p = join(base, d, ...rel);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

// Find a usable Chromium without requiring the caller to set an env var. Order:
// explicit EB_CHROMIUM_PATH, then any Playwright browser cache (the run/web
// environments preinstall under PLAYWRIGHT_BROWSERS_PATH; a local `npx playwright
// install` uses the per-OS default cache), then a system Chrome/Chromium/Edge.
// Cross-platform so `npm run dev` renders PDFs on a Mac/Windows workstation, not
// only in the Linux container. Returns undefined to let Playwright try its default.
export function resolveChromium(): string | undefined {
  const envPath = process.env.EB_CHROMIUM_PATH;
  if (envPath && existsSync(envPath)) return envPath;

  const home = process.env.HOME || process.env.USERPROFILE || '';
  const cacheBases = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    '/opt/pw-browsers',
    '/ms-playwright',
    home && join(home, '.cache', 'ms-playwright'), // Linux default
    home && join(home, 'Library', 'Caches', 'ms-playwright'), // macOS default
    home && join(home, 'AppData', 'Local', 'ms-playwright'), // Windows default
  ].filter((v): v is string => !!v);
  for (const base of cacheBases) {
    const found = findChromiumInCache(base);
    if (found) return found;
  }

  for (const p of [
    // Linux
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    // Windows
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ]) {
    if (existsSync(p)) return p;
  }
  return undefined;
}

export async function renderReportPdf(
  html: string,
  opts: { footerLeft?: string } = {},
): Promise<Buffer> {
  // playwright-core (not @playwright/test) so PDF rendering works in production,
  // where devDependencies are omitted. It ships no browsers/test-runner; the
  // Chromium binary is located by resolveChromium().
  const { chromium } = await import('playwright-core');
  const executablePath = resolveChromium();
  let browser;
  try {
    browser = await chromium.launch(executablePath ? { executablePath } : {});
  } catch (err) {
    throw new Error(
      `PDF rendering is unavailable: could not launch Chromium (${(err as Error).message.split('\n')[0]}). ` +
        `In local dev, install a browser with 'npx playwright install chromium', or set ` +
        `EB_CHROMIUM_PATH to an existing Chromium/Chrome binary.`,
    );
  }
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle' });
    const footer = `<div style="width:100%;font-size:8px;color:#8a968c;padding:0 0.72in;display:flex;justify-content:space-between;">
      <span>${esc(opts.footerLeft ?? '')}</span>
      <span>Powered by Exit Blueprint &nbsp;·&nbsp; <span class="pageNumber"></span> / <span class="totalPages"></span></span>
    </div>`;
    return await page.pdf({
      format: 'Letter',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: footer,
      margin: { top: '0', bottom: '0.55in', left: '0', right: '0' },
    });
  } finally {
    await browser.close();
  }
}
