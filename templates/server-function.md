# Template: new server function

A `/functions/v1/<name>` endpoint. Wire it in 4 places (see `docs/27` §2). The
router (`server/functions.ts`) is transport-agnostic — the handler must not touch
HTTP; it takes a pg client + the caller's firm id (resolved upstream, never from
the body).

### 1. Handler — in `server/<domain>.ts`
```ts
import type pg from 'pg';

export async function doThing(
  db: pg.ClientBase,
  firmId: string,
  body: { engagement_id: string; /* ... */ },
): Promise<{ ok: true; /* ... */ }> {
  // Query under the service role; firmId is trusted (resolved from the profile).
  const row = (
    await db.query(`select id from engagements where id = $1 and firm_id = $2`, [
      body.engagement_id,
      firmId,
    ])
  ).rows[0];
  if (!row) throw new Error('engagement not found');
  // ... do the work ...
  return { ok: true };
}
```

### 2. Authorize — in `server/functions.ts` `authorize()`
Add `'<name>'` to the correct group set so firm + RLS resolution runs first:
```ts
const FIRM_FNS = new Set([ /* ... */, '<name>' ]);
```

### 3. Dispatch — in `server/functions.ts` `dispatch()`
```ts
case '<name>':
  return ok(await doThing(service, firmId as string, body as never));
```

### 4. Frontend — call it
```ts
import { invokeFunction } from '../lib/supabase';
const res = await invokeFunction<{ ok: true }>('<name>', { engagement_id });
```
Paid action? add `'<name>'` to `GATED_FNS` in `server/entitlements.ts`.

**DoD:** a test in `tests/functions.test.ts` (or a domain test) covers the happy
path and a foreign-firm deny; `npm test` green.
