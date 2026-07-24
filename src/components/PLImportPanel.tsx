import { useState, type FormEvent } from 'react';
import { invokeFunction } from '../lib/supabase';
import { downloadBlob } from '../lib/download';
import { track } from '../lib/analytics';
import { fmtCurrency } from '../lib/format';
import { ErrorState, useToast } from './ui';

// A proposed financial answer from the deterministic extractor (server/pl-extract.ts).
export interface FinancialEntry {
  code: string;
  value: unknown;
}
interface RecognizedFigure {
  code: string;
  label: string;
  value: unknown;
  detail: string;
}
interface ExtractResult {
  format: string;
  entries: FinancialEntry[];
  recognized: RecognizedFigure[];
  notes: string[];
  warnings: string[];
  verifiable: boolean;
}

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_EXTENSIONS = ['xlsx', 'csv', 'tsv', 'txt', 'json'];
const ACCEPT_ATTR = ALLOWED_EXTENSIONS.map((e) => `.${e}`).join(',');

const toBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve((r.result as string).split(',')[1] ?? '');
    r.onerror = () => reject(new Error('could not read file'));
    r.readAsDataURL(file);
  });

function validateFile(file: File): string | null {
  const dot = file.name.lastIndexOf('.');
  const ext = dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : '';
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    const hint =
      ext === 'xls'
        ? ' Re-save it as .xlsx (Excel’s “Save As”), or export the Profit and Loss report to CSV.'
        : ext === 'pdf'
          ? ' In QuickBooks, open the Profit and Loss report and use Export → Export to CSV.'
          : '';
    return `That file type can't be read for financials. Upload an Excel (.xlsx), CSV, or JSON export (${ALLOWED_EXTENSIONS.join(', ')}).${hint}`;
  }
  if (file.size === 0) return 'That file is empty.';
  if (file.size > MAX_BYTES) return 'That file is larger than the 5 MB limit.';
  return null;
}

// Human-readable rendering of a proposed value, by question code.
function renderValue(fig: RecognizedFigure): string {
  if (fig.code === 'REV-ANNUAL' && Array.isArray(fig.value)) {
    return (fig.value as number[]).map((n) => fmtCurrency(n)).join('  →  ');
  }
  if ((fig.code === 'REV-TOP5-SHARES') && Array.isArray(fig.value)) {
    return (fig.value as number[]).map((n) => `${n}%`).join(', ');
  }
  if (fig.code === 'REV-RECUR-PCT') return `${fig.value}%`;
  return String(fig.value);
}

// A downloadable sample so the expected P&L shape is discoverable. This is a
// realistic, fully-footing four-year statement — a title/date preamble, indented
// sub-accounts under section roll-ups, a "Total revenue" line across year
// columns, an "of which recurring" memo line, COGS, gross profit, an operating-
// expense breakdown, and operating income — the shape a real QuickBooks/Excel
// P&L export takes. The extractor reads the Total revenue trend and the recurring
// share from it; everything else is there so the file looks like the advisor's
// own statement, not a toy.
const SAMPLE_CSV = [
  'Cascade Water Solutions',
  'Profit & Loss Statement — fiscal years ending December 31',
  '(USD)',
  ',FY2022,FY2023,FY2024,FY2025',
  'Revenue,,,,',
  '  Product revenue,"1,900,000","2,050,000","2,300,000","2,500,000"',
  '  Service revenue,"2,900,000","3,350,000","3,900,000","4,400,000"',
  'Total revenue,"4,800,000","5,400,000","6,200,000","6,900,000"',
  '  of which recurring revenue,"2,976,000","3,510,000","4,092,000","4,554,000"',
  'Cost of goods sold,,,,',
  '  Materials & equipment,"1,180,000","1,290,000","1,440,000","1,560,000"',
  '  Direct labor,"932,000","1,032,000","1,164,000","1,269,000"',
  'Total cost of goods sold,"2,112,000","2,322,000","2,604,000","2,829,000"',
  'Gross profit,"2,688,000","3,078,000","3,596,000","4,071,000"',
  'Operating expenses,,,,',
  '  Salaries & wages,"1,260,000","1,380,000","1,560,000","1,700,000"',
  '  Sales & marketing,"400,000","470,000","560,000","620,000"',
  '  Rent & facilities,"210,000","220,000","230,000","240,000"',
  '  General & administrative,"178,000","188,000","246,000","311,000"',
  'Total operating expenses,"2,048,000","2,258,000","2,596,000","2,871,000"',
  'Operating income,"640,000","820,000","1,000,000","1,200,000"',
].join('\n');

/**
 * "Fill financials from a P&L" — a collapsible intake affordance. The advisor
 * uploads a P&L (or a revenue-by-customer report); the server extracts the
 * financial figures DETERMINISTICALLY (no LLM), the advisor reviews them, and
 * on Apply they're written to the assessment as `document`-verified answers via
 * enter-manual-financials. onApplied lets the intake refresh the affected fields.
 */
export function PLImportPanel({
  assessmentId,
  firmId,
  engagementId,
  profileId,
  onApplied,
}: {
  assessmentId: string;
  firmId?: string;
  engagementId?: string;
  profileId?: string;
  onApplied: (entries: FinancialEntry[]) => void;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExtractResult | null>(null);
  const [applied, setApplied] = useState(false);

  const reset = () => {
    setFile(null);
    setResult(null);
    setApplied(false);
    setError(null);
    setFormKey((k) => k + 1);
  };

  const downloadSample = () => {
    const blob = new Blob([SAMPLE_CSV], { type: 'text/csv' });
    downloadBlob(blob, 'sample-pl.csv');
  };

  const extract = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    const invalid = validateFile(file);
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError(null);
    setApplied(false);
    try {
      const content_base64 = await toBase64(file);
      const res = await invokeFunction<ExtractResult>('extract-financials-from-file', {
        assessment_id: assessmentId,
        filename: file.name,
        mime_type: file.type || 'application/octet-stream',
        content_base64,
      });
      setResult(res);
      if (res.recognized.length === 0) {
        setError(
          res.notes[0] ??
            "Couldn't read any financial figures from that file. Check the format against the sample.",
        );
      }
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };

  const apply = async () => {
    if (!result || result.entries.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      // Persist the P&L itself as the STORED evidence, then attest the extracted
      // figures against it. Without a stored document (or if it fails to upload),
      // the server records the figures as self_reported rather than verified —
      // and figures that failed a plausibility check are never claimed verified.
      let evidenceDocumentId: string | null = null;
      if (file && engagementId) {
        try {
          const content_base64 = await toBase64(file);
          const up = await invokeFunction<{ document_id?: string; status?: string }>('upload-document', {
            engagement_id: engagementId,
            category: 'Financial statement (P&L)',
            filename: file.name,
            mime_type: file.type || 'text/csv',
            content_base64,
          });
          if (up?.status !== 'rejected' && up?.document_id) evidenceDocumentId = up.document_id;
        } catch {
          evidenceDocumentId = null; // fall through — recorded self_reported below
        }
      }
      const documented = result.verifiable && evidenceDocumentId != null;
      await invokeFunction('enter-manual-financials', {
        assessment_id: assessmentId,
        entries: result.entries,
        documented,
        evidence_document_id: evidenceDocumentId,
      });
      track({
        type: 'assessment',
        name: 'financials_imported',
        firmId,
        profileId,
        engagementId,
        properties: {
          assessment_id: assessmentId,
          format: result.format,
          codes: result.entries.map((e) => e.code),
          verified: documented,
        },
      });
      onApplied(result.entries);
      setApplied(true);
      const n = result.entries.length;
      toast.show(
        documented
          ? `Filled ${n} financial field${n > 1 ? 's' : ''} from the file, recorded as verified`
          : `Filled ${n} field${n > 1 ? 's' : ''}, recorded as self-reported (no stored document backing them)`,
        documented ? 'good' : 'default',
      );
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };

  return (
    <div className="pl-import">
      <button
        type="button"
        className="pl-import-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="pl-import-toggle-icon" aria-hidden>
          {open ? '▾' : '▸'}
        </span>
        <span>
          <strong>Fill financials from a P&amp;L.</strong>
          <span className="muted">
            {' '}
            Upload a profit &amp; loss statement or revenue export and we’ll pre-fill the
            revenue, recurring-revenue, and concentration questions.
          </span>
        </span>
      </button>

      {open && (
        <div className="pl-import-body">
          <p className="muted m-0">
            Values are read directly from the file (no AI) and shown for your review. On apply, the
            file is stored as the backing document and the figures are recorded as{' '}
            <strong>verified</strong>, unless a plausibility check flags them, in which case they are
            recorded as self-reported for you to confirm. Everything else stays for you to answer.
            Accepts Excel (.xlsx), CSV, and JSON exports.{' '}
            <button type="button" className="linkish" onClick={downloadSample}>
              Download a sample P&amp;L
            </button>
          </p>

          <form className="inline-form" onSubmit={extract}>
            <input
              key={formKey}
              type="file"
              accept={ACCEPT_ATTR}
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setResult(null);
                setApplied(false);
                setError(null);
              }}
            />
            <button type="submit" disabled={!file || busy}>
              {busy && !result ? 'Reading…' : 'Read file'}
            </button>
          </form>

          {error && <ErrorState variant="inline" error={error} />}

          {result && result.recognized.length > 0 && (
            <div className="pl-import-result">
              <h4 className="m-0">
                {applied ? 'Applied to the assessment' : `Found ${result.recognized.length} figure${result.recognized.length > 1 ? 's' : ''}`}
              </h4>
              <ul className="pl-import-figures">
                {result.recognized.map((fig) => (
                  <li key={fig.code}>
                    <div className="pl-fig-head">
                      <span className="pl-fig-label">{fig.label}</span>
                      <span className="pl-fig-value">{renderValue(fig)}</span>
                    </div>
                    <span className="pl-fig-detail muted">{fig.detail}</span>
                  </li>
                ))}
              </ul>
              {result.warnings.length > 0 && (
                <ul className="pl-import-notes" role="alert">
                  {result.warnings.map((w, i) => (
                    <li key={i}>⚠ {w}</li>
                  ))}
                  <li className="muted">
                    These figures will be recorded as self-reported (not verified) until corrected.
                  </li>
                </ul>
              )}
              {result.notes.length > 0 && (
                <ul className="pl-import-notes muted">
                  {result.notes.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              )}
              {!applied ? (
                <div className="row-gap">
                  <button type="button" onClick={apply} disabled={busy}>
                    {busy ? 'Applying…' : `Apply ${result.entries.length} figure${result.entries.length > 1 ? 's' : ''}`}
                  </button>
                  <button type="button" className="btn-ghost" onClick={reset} disabled={busy}>
                    Discard
                  </button>
                </div>
              ) : (
                <button type="button" className="btn-ghost" onClick={reset}>
                  Import another file
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
