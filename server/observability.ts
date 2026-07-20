// Observability for the Node compute service (server/http.ts) — a thin,
// vendor-neutral seam over error monitoring, mirroring the adapter pattern the
// codebase already uses (ParserAdapter/StorageAdapter, docs/27). Sentry never
// leaks past this file: the rest of the service calls captureError/captureMessage
// and gets consistent structured logs whether or not a DSN is configured.
//
// Disabled by default: with no SENTRY_DSN, every capture is a Sentry no-op (it
// still emits the structured console line, so access/error logs are identical in
// dev/CI/beta) and no SDK is initialized. Enable in production by setting
// SENTRY_DSN on the Render service (docs/32).
//
// Hard rule (CLAUDE.md): never log secrets, tokens, request bodies, or PII beyond
// ids. Context is scrubbed here before it reaches either the console or Sentry.
import * as Sentry from '@sentry/node';

// Sentry's severity levels (kept local so callers don't import from @sentry).
export type Level = 'debug' | 'info' | 'warning' | 'error' | 'fatal';

// A small structured context: route, firmId, function name, ids. Anything
// sensitive (tokens, bodies, PII) is dropped by scrubContext before use.
export type Context = Record<string, unknown>;

// The vendor seam. captureError/captureMessage forward a structured event to the
// backend; the console line is emitted by the module wrappers below (so logs are
// identical regardless of which sink is active). Two impls: ConsoleSink (no vendor
// — the "disabled" default) and SentrySink (forwards to @sentry/node).
interface Sink {
  readonly name: string;
  captureError(err: unknown, context?: Context): void;
  captureMessage(msg: string, level: Level, context?: Context): void;
}

// Disabled default: no vendor forwarding. The structured console line still fires
// from the module wrappers, so nothing is lost — Sentry simply isn't called.
class ConsoleSink implements Sink {
  readonly name = 'console';
  captureError(): void {
    /* no-op: the wrapper already emitted the structured console.error line */
  }
  captureMessage(): void {
    /* no-op: the wrapper already emitted the structured console line */
  }
}

// Sentry-backed sink. Attaches scrubbed context under a single "eb" context key
// so it shows up grouped in the Sentry event without polluting tags.
class SentrySink implements Sink {
  readonly name = 'sentry';
  captureError(err: unknown, context?: Context): void {
    Sentry.withScope((scope) => {
      if (context) scope.setContext('eb', context);
      Sentry.captureException(err);
    });
  }
  captureMessage(msg: string, level: Level, context?: Context): void {
    Sentry.withScope((scope) => {
      if (context) scope.setContext('eb', context);
      Sentry.captureMessage(msg, level);
    });
  }
}

// Chosen once at init. Starts disabled so importing this module never has side
// effects (tests, dev, CI) — initObservability() flips it to Sentry when a DSN
// is present.
let sink: Sink = new ConsoleSink();
let enabled = false;

// Keys whose values must never be logged or sent to Sentry — tokens, secrets,
// auth material, raw request bodies, and direct PII. Matched case-insensitively
// against the key name (substring), so `authorization`, `x-api-key`,
// `jwt_token`, `passwordHash` all drop.
const SENSITIVE_KEY = /(token|secret|password|passwd|authorization|auth|cookie|jwt|apikey|api[-_]?key|bearer|dsn|session|ssn|email|phone|body|payload)/i;

// Ids we explicitly allow even though they contain a blocked substring above
// (e.g. "firmId" is fine; the regex would otherwise never match it, but this
// documents intent and guards future edits).
const ALLOWED_KEY = /^(route|fn|firmId|firm_id|engagementId|assessmentId|userId|documentId|status|method|path|ms|name|op|reason)$/;

// Produce a log/telemetry-safe copy of a context object: drop sensitive keys,
// keep only primitive scalar values (so a whole request body or nested object
// can't ride along), and cap string length. Exported for testing.
export function scrubContext(context?: Context): Context | undefined {
  if (!context || typeof context !== 'object') return undefined;
  const out: Context = {};
  for (const [key, value] of Object.entries(context)) {
    if (!ALLOWED_KEY.test(key) && SENSITIVE_KEY.test(key)) continue; // sensitive → drop
    if (value == null) continue;
    // Only scalars survive — no arrays/objects (could carry a body or PII).
    if (typeof value === 'string') {
      out[key] = value.length > 200 ? `${value.slice(0, 200)}…` : value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    }
    // functions, objects, arrays, symbols, bigints: intentionally dropped
  }
  return Object.keys(out).length ? out : undefined;
}

// Normalize any thrown value into { name, message } for structured logging,
// without ever stringifying a whole object that might carry sensitive fields.
function errorSummary(err: unknown): { name: string; message: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  if (typeof err === 'string') return { name: 'Error', message: err };
  if (err && typeof err === 'object') {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string') return { name: 'Error', message: m };
  }
  return { name: 'Error', message: String(err) };
}

// Emit one JSON line to a console stream. All structured logs go through here so
// the format is uniform and greppable in Render's log drain.
function logLine(
  stream: 'log' | 'error',
  fields: Record<string, unknown>,
): void {
  const line = JSON.stringify({ t: new Date().toISOString(), ...fields });
  if (stream === 'error') console.error(line);
  else console.log(line);
}

// Read a numeric env var, falling back when unset/invalid.
function numberEnv(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

// Initialize error monitoring. Reads SENTRY_DSN (+ optional SENTRY_ENVIRONMENT,
// SENTRY_TRACES_SAMPLE_RATE). With no DSN this is a no-op beyond one log line, and
// captureError/captureMessage stay console-only. Safe to call once at startup.
export function initObservability(env: NodeJS.ProcessEnv = process.env): void {
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) {
    enabled = false;
    sink = new ConsoleSink();
    console.log('observability: disabled (no SENTRY_DSN)');
    return;
  }
  Sentry.init({
    dsn,
    environment: env.SENTRY_ENVIRONMENT?.trim() || env.NODE_ENV || 'production',
    tracesSampleRate: numberEnv(env.SENTRY_TRACES_SAMPLE_RATE, 0),
    // Don't let the SDK attach request bodies / headers by default — we send only
    // the scrubbed context we build explicitly.
    sendDefaultPii: false,
  });
  enabled = true;
  sink = new SentrySink();
  console.log(
    `observability: enabled (sentry, env=${env.SENTRY_ENVIRONMENT?.trim() || env.NODE_ENV || 'production'})`,
  );
}

// Whether Sentry is active. Mostly for tests/diagnostics.
export function isObservabilityEnabled(): boolean {
  return enabled;
}

// Report an error. Always emits a structured console.error line (uniform access
// logs); forwards to Sentry only when enabled. Context is scrubbed first. Never
// throws — observability must not be able to break a request path.
export function captureError(err: unknown, context?: Context): void {
  const safe = scrubContext(context);
  try {
    const { name, message } = errorSummary(err);
    logLine('error', { level: 'error', msg: 'captured_error', error: { name, message }, ...(safe ?? {}) });
    sink.captureError(err, safe);
  } catch {
    /* swallow — a logging failure must never propagate */
  }
}

// Report a message (a noteworthy non-exception event). Same guarantees as
// captureError. Default level 'info'.
export function captureMessage(msg: string, level: Level = 'info', context?: Context): void {
  const safe = scrubContext(context);
  try {
    logLine(level === 'error' || level === 'fatal' ? 'error' : 'log', {
      level,
      msg: 'captured_message',
      message: msg,
      ...(safe ?? {}),
    });
    sink.captureMessage(msg, level, safe);
  } catch {
    /* swallow */
  }
}

// Consistent access logging for the Node service: one JSON line per request with
// method, path, status, and duration. Console-based (no Sentry) — this is a log,
// not an event. Never throws.
export function logRequest(entry: { method: string; path: string; status: number; ms: number }): void {
  try {
    logLine('log', {
      level: 'info',
      msg: 'request',
      method: entry.method,
      path: entry.path,
      status: entry.status,
      ms: Math.round(entry.ms),
    });
  } catch {
    /* swallow */
  }
}
