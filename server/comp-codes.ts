// Comp-code redemption — the self-serve half of the paywall (docs/24 §5.7).
//
// A comp code grants a firm complimentary access without Stripe: redeeming one
// sets firm_subscriptions.comp = true, which shared/entitlements treats as fully
// entitled regardless of Stripe status. This is how pilot / design-partner firms
// get through a BILLING_ENFORCED=true build.
//
// Structure mirrors server/stripe.ts: a PURE validity check (`compCodeFailure`,
// no DB, no clock — `now` is passed in) that is unit-tested with hand-built rows,
// and a thin DB wrapper (`redeemCompCode`) that runs under the service role
// (comp_codes is service-only) with the firmId resolved upstream from the caller's
// profile, never the request body.
import type pg from 'pg';
import { resolveEntitlement, type Entitlement } from '../shared/entitlements';

// Read a firm's entitlement from the cached billing rows. Duplicated from
// server/entitlements.getFirmEntitlement deliberately: importing that module here
// would pull in its eager top-level GATED_FNS (which reads the registry), and this
// module is imported BY the registry — a cycle that leaves REGISTRY undefined at
// load. Depending only on the pure shared resolver keeps the graph acyclic.
async function readEntitlement(db: pg.ClientBase, firmId: string): Promise<Entitlement> {
  const sub =
    (await db.query(`select plan_code, status, seats, comp from firm_subscriptions where firm_id = $1`, [firmId]))
      .rows[0] ?? null;
  const plan = sub?.plan_code
    ? (await db.query(`select code, name, seat_limit, engagement_limit, features from plans where code = $1`, [
        sub.plan_code,
      ])).rows[0] ?? null
    : null;
  return resolveEntitlement(
    sub && { plan_code: sub.plan_code, status: sub.status, seats: sub.seats, comp: sub.comp },
    plan && {
      code: plan.code,
      name: plan.name,
      seat_limit: plan.seat_limit,
      engagement_limit: plan.engagement_limit,
      features: Array.isArray(plan.features) ? plan.features : [],
    },
  );
}

// Codes are stored normalized so entry is forgiving: ' demo-2026 ' matches
// 'DEMO-2026'. Mint and redeem both go through this, so the two can't drift.
export function normalizeCompCode(raw: string): string {
  return raw.trim().toUpperCase();
}

export type CompCodeFailureReason = 'not_found' | 'inactive' | 'expired' | 'exhausted';

export interface CompCodeRow {
  code: string;
  plan_code: string | null;
  max_redemptions: number | null;
  redeemed_count: number;
  expires_at: string | null;
  active: boolean;
}

export interface CompCodeFailure {
  reason: CompCodeFailureReason;
  message: string;
}

// Pure: given the code row (or null), whether THIS firm already redeemed it, and
// the current time, return a failure or null (= redeemable). A code the firm has
// already redeemed is always redeemable again (idempotent re-apply), so an
// exhausted/expired code the firm already holds still re-applies its comp.
export function compCodeFailure(
  row: CompCodeRow | null,
  alreadyRedeemed: boolean,
  now: number,
): CompCodeFailure | null {
  if (!row) return { reason: 'not_found', message: 'That access code is not valid.' };
  if (alreadyRedeemed) return null; // a firm can always re-apply a code it already holds
  if (!row.active) return { reason: 'inactive', message: 'That access code is no longer active.' };
  if (row.expires_at && new Date(row.expires_at).getTime() <= now)
    return { reason: 'expired', message: 'That access code has expired.' };
  if (row.max_redemptions != null && row.redeemed_count >= row.max_redemptions)
    return { reason: 'exhausted', message: 'That access code has already been fully redeemed.' };
  return null;
}

export type RedeemOutcome =
  | { ok: true; entitlement: Entitlement; alreadyRedeemed: boolean; planCode: string | null }
  | { ok: false; reason: CompCodeFailureReason; message: string };

// Validate + redeem a comp code for a firm. Idempotent per (code, firm): a second
// redemption by the same firm re-applies the comp without consuming another slot
// (the unique constraint + the alreadyRedeemed short-circuit guarantee it). Runs
// under the service role; firmId is trusted (resolved from the caller's profile).
export async function redeemCompCode(
  db: pg.ClientBase,
  args: { code: string; firmId: string; redeemedBy?: string | null; now?: number },
): Promise<RedeemOutcome> {
  const code = normalizeCompCode(args.code);
  if (!code) return { ok: false, reason: 'not_found', message: 'Enter an access code.' };
  const now = args.now ?? Date.now();

  const row =
    ((
      await db.query(
        `select code, plan_code, max_redemptions, redeemed_count, expires_at, active
           from comp_codes where code = $1`,
        [code],
      )
    ).rows[0] as CompCodeRow | undefined) ?? null;

  const alreadyRedeemed = Boolean(
    (await db.query(`select 1 from comp_code_redemptions where code = $1 and firm_id = $2`, [code, args.firmId]))
      .rowCount,
  );

  const failure = compCodeFailure(row, alreadyRedeemed, now);
  if (failure) return { ok: false, ...failure };
  // compCodeFailure returns null only when row is present.
  const compRow = row as CompCodeRow;

  if (!alreadyRedeemed) {
    // Record the redemption first (idempotent insert), then count it. `on conflict
    // do nothing` means a racing duplicate for the same firm inserts zero rows and
    // does not bump the counter.
    const inserted = await db.query(
      `insert into comp_code_redemptions (code, firm_id, redeemed_by) values ($1, $2, $3)
       on conflict (code, firm_id) do nothing`,
      [code, args.firmId, args.redeemedBy ?? null],
    );
    if (inserted.rowCount) {
      await db.query(`update comp_codes set redeemed_count = redeemed_count + 1 where code = $1`, [code]);
    }
  }

  // Apply the comp: upsert the firm's one subscription row with comp = true and the
  // code's plan (if any). coalesce never downgrades an existing plan to null, and
  // an existing real Stripe status is left untouched (comp overrides it anyway).
  await db.query(
    `insert into firm_subscriptions (firm_id, plan_code, comp, status)
       values ($1, $2, true, 'active')
     on conflict (firm_id) do update set
       comp = true,
       plan_code = coalesce(excluded.plan_code, firm_subscriptions.plan_code),
       updated_at = now()`,
    [args.firmId, compRow.plan_code],
  );

  const entitlement = await readEntitlement(db, args.firmId);
  return { ok: true, entitlement, alreadyRedeemed, planCode: compRow.plan_code };
}

// Mint a comp code (operator action — CLI scripts/admin.ts). Normalizes the code
// and upserts, so re-running with the same code updates its label/limits rather
// than erroring. Runs under the service role.
export async function createCompCode(
  db: pg.ClientBase,
  args: {
    code: string;
    label: string;
    planCode?: string | null;
    maxRedemptions?: number | null;
    expiresAt?: string | null;
    createdBy?: string | null;
  },
): Promise<CompCodeRow> {
  const code = normalizeCompCode(args.code);
  if (!code) throw new Error('code is required');
  const row = (
    await db.query(
      `insert into comp_codes (code, label, plan_code, max_redemptions, expires_at, created_by)
         values ($1, $2, $3, $4, $5, $6)
       on conflict (code) do update set
         label = excluded.label,
         plan_code = excluded.plan_code,
         max_redemptions = excluded.max_redemptions,
         expires_at = excluded.expires_at
       returning code, plan_code, max_redemptions, redeemed_count, expires_at, active`,
      [
        code,
        args.label,
        args.planCode ?? null,
        args.maxRedemptions ?? null,
        args.expiresAt ?? null,
        args.createdBy ?? null,
      ],
    )
  ).rows[0] as CompCodeRow;
  return row;
}
