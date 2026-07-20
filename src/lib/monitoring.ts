// Frontend error monitoring — the browser counterpart to server/observability.ts.
// Vendor-neutral: the app calls captureError / wraps in MonitoringErrorBoundary
// and never imports @sentry/react directly, so Sentry stays behind this seam.
//
// Disabled by default: with no VITE_SENTRY_DSN, initMonitoring() is a no-op and
// captureError only console.errors. Enable in production by setting VITE_SENTRY_DSN
// in Vercel (docs/32).
//
// Bundle impact: @sentry/react is loaded via a DYNAMIC import, only when a DSN is
// present. The no-DSN build (local dev / CI / a deploy without the var) therefore
// never pulls the SDK into the entry chunk — it stays in a chunk that's only
// fetched when monitoring is actually turned on.
import React from 'react';

export type Level = 'debug' | 'info' | 'warning' | 'error' | 'fatal';
export type Context = Record<string, unknown>;

// Minimal Sentry surface we use — avoids a type import from @sentry/react in the
// no-DSN build and documents exactly what this seam depends on.
interface SentryApi {
  init(options: Record<string, unknown>): void;
  captureException(err: unknown): void;
  captureMessage(msg: string, level?: Level): void;
  withScope(fn: (scope: { setContext(key: string, ctx: Context): void }) => void): void;
  browserTracingIntegration(): unknown;
}

let sentry: SentryApi | null = null;
let enabled = false;

// Same scrubbing contract as the server: drop tokens/secrets/PII/bodies, keep
// only scalar ids and small strings. Kept local (the frontend can't import server
// code) but intentionally identical in spirit.
const SENSITIVE_KEY = /(token|secret|password|passwd|authorization|auth|cookie|jwt|apikey|api[-_]?key|bearer|dsn|session|ssn|email|phone|body|payload)/i;
const ALLOWED_KEY = /^(route|fn|firmId|firm_id|engagementId|assessmentId|userId|documentId|status|method|path|ms|name|op|reason|component)$/;

export function scrubContext(context?: Context): Context | undefined {
  if (!context || typeof context !== 'object') return undefined;
  const out: Context = {};
  for (const [key, value] of Object.entries(context)) {
    if (!ALLOWED_KEY.test(key) && SENSITIVE_KEY.test(key)) continue;
    if (value == null) continue;
    if (typeof value === 'string') out[key] = value.length > 200 ? `${value.slice(0, 200)}…` : value;
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

// Read VITE_SENTRY_DSN (trimmed). import.meta.env is a Vite feature; guard it so
// this module is also importable from a non-Vite context (e.g. a unit test).
function readDsn(): string | undefined {
  try {
    const dsn = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_SENTRY_DSN;
    return dsn?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function readEnv(name: string): string | undefined {
  try {
    return (import.meta as { env?: Record<string, string | undefined> }).env?.[name]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

// Initialize monitoring. No DSN ⇒ no-op (nothing loaded). With a DSN, dynamically
// import @sentry/react and init it. Returns a promise so a caller can await the
// SDK load if it wants, but awaiting is optional — captureError degrades to
// console-only until the import resolves.
export async function initMonitoring(): Promise<void> {
  const dsn = readDsn();
  if (!dsn) {
    enabled = false;
    console.log('monitoring: disabled (no VITE_SENTRY_DSN)');
    return;
  }
  try {
    const mod = (await import('@sentry/react')) as unknown as SentryApi;
    const traces = Number(readEnv('VITE_SENTRY_TRACES_SAMPLE_RATE'));
    mod.init({
      dsn,
      environment: readEnv('VITE_SENTRY_ENVIRONMENT') || 'production',
      integrations: [mod.browserTracingIntegration()],
      tracesSampleRate: Number.isFinite(traces) ? traces : 0,
      sendDefaultPii: false,
    });
    sentry = mod;
    enabled = true;
    console.log('monitoring: enabled (sentry)');
  } catch (e) {
    // A monitoring failure must never break app boot.
    enabled = false;
    console.error('monitoring: failed to initialize', (e as Error)?.message);
  }
}

export function isMonitoringEnabled(): boolean {
  return enabled;
}

// Report an error. Always console.errors a structured line; forwards to Sentry
// when loaded. Context is scrubbed first. Never throws.
export function captureError(err: unknown, context?: Context): void {
  const safe = scrubContext(context);
  try {
    const name = err instanceof Error ? err.name : 'Error';
    const message = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ level: 'error', msg: 'captured_error', error: { name, message }, ...(safe ?? {}) }));
    if (sentry) {
      sentry.withScope((scope) => {
        if (safe) scope.setContext('eb', safe);
        sentry!.captureException(err);
      });
    }
  } catch {
    /* swallow — monitoring must not break the UI */
  }
}

export function captureMessage(msg: string, level: Level = 'info', context?: Context): void {
  const safe = scrubContext(context);
  try {
    console.log(JSON.stringify({ level, msg: 'captured_message', message: msg, ...(safe ?? {}) }));
    if (sentry) {
      sentry.withScope((scope) => {
        if (safe) scope.setContext('eb', safe);
        sentry!.captureMessage(msg, level);
      });
    }
  } catch {
    /* swallow */
  }
}

// A vendor-neutral React error boundary the app can wrap around its tree. It
// forwards any render-time crash to captureError (→ Sentry when enabled) and
// renders `fallback`. Built with React.createElement so this file stays a plain
// .ts module (no JSX) and works whether or not the Sentry SDK has loaded.
interface BoundaryProps {
  children?: React.ReactNode;
  fallback?: React.ReactNode;
}
interface BoundaryState {
  hasError: boolean;
}

export class MonitoringErrorBoundary extends React.Component<BoundaryProps, BoundaryState> {
  constructor(props: BoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError(): BoundaryState {
    return { hasError: true };
  }
  componentDidCatch(error: unknown, info: { componentStack?: string }): void {
    captureError(error, { component: 'error-boundary', reason: info?.componentStack ? 'render' : 'unknown' });
  }
  render(): React.ReactNode {
    if (this.state.hasError) return this.props.fallback ?? null;
    return this.props.children ?? null;
  }
}
