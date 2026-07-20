// CORS origin resolution for the compute service (server/http.ts).
//
// Access-Control-Allow-Origin may only ever be a SINGLE origin or '*' — never a
// comma-joined list of origins. FUNCTIONS_ALLOWED_ORIGIN is documented (and used
// in prod) as a comma-separated allowlist, so the value has to be parsed and the
// request's own Origin echoed back when it matches. Emitting the raw comma-joined
// string produces a header every browser rejects at preflight, which surfaces in
// the app as a blanket "we couldn't reach the server" on every function-backed
// view — the request fails as a CORS/fetch error, not a real server outage.

// Parse a FUNCTIONS_ALLOWED_ORIGIN value into a clean list of origins. Missing
// or empty ⇒ ['*'] (allow any), the permissive default the Dockerfile documents.
export function parseAllowedOrigins(raw: string | undefined): string[] {
  const list = (raw ?? '*')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  return list.length ? list : ['*'];
}

// The single value to emit in Access-Control-Allow-Origin for one request:
//  - '*' when the allowlist is empty or explicitly contains '*' (allow any).
//  - the caller's Origin when it's in the allowlist, so a multi-origin deploy
//    (apex + www, or an app + marketing origin) works — this is the case the old
//    comma-joined header silently broke.
//  - otherwise the first configured origin: a stable, valid value the browser
//    then correctly blocks a non-listed origin against, rather than a malformed
//    header that breaks even the allowed origins.
export function resolveCorsOrigin(allowed: string[], requestOrigin: string | undefined): string {
  if (allowed.length === 0 || allowed.includes('*')) return '*';
  if (requestOrigin && allowed.includes(requestOrigin)) return requestOrigin;
  return allowed[0];
}
