// Pure mapping helpers for Clerk provisioning (server/clerk.ts). No network, no
// CLERK_SECRET_KEY — runs everywhere including CI, which has no Clerk keys. The
// networked provisioning calls are exercised against a live Clerk app by the
// operator (scripts/admin.ts); here we lock the app<->Clerk mapping rules.
import { describe, expect, it } from 'vitest';
import { clerkEnabled, orgRoleForAppRole, splitName } from '../server/clerk';

describe('orgRoleForAppRole', () => {
  it('maps the app admin to the Clerk org admin', () => {
    expect(orgRoleForAppRole('admin')).toBe('org:admin');
  });

  it('maps every non-admin app role to org:member', () => {
    for (const role of ['advisor', 'reviewer', 'owner'] as const) {
      expect(orgRoleForAppRole(role)).toBe('org:member');
    }
  });
});

describe('splitName', () => {
  it('returns no fields for a blank or missing name', () => {
    expect(splitName(null)).toEqual({});
    expect(splitName('   ')).toEqual({});
  });

  it('uses a single token as the first name only', () => {
    expect(splitName('Jo')).toEqual({ first_name: 'Jo' });
  });

  it('splits first token vs. the rest as first/last name', () => {
    expect(splitName('Jo Van Der Berg')).toEqual({ first_name: 'Jo', last_name: 'Van Der Berg' });
  });
});

describe('clerkEnabled', () => {
  it('is gated on CLERK_SECRET_KEY (unset in CI)', () => {
    // The test env has no Clerk key, so provisioning stays on the dev path.
    expect(clerkEnabled()).toBe(Boolean(process.env.CLERK_SECRET_KEY));
  });
});
