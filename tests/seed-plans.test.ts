import { describe, expect, it } from 'vitest';
import { SYSTEM_PLANS, validateSystemPlans } from '../server/seed-methodology';

// Real code sets the shipped SYSTEM_PLANS reference; used to prove the happy path.
const PLAYBOOKS = new Set([
  'PB-CLEAN-BOOKS', 'PB-ADDBACK-DOC', 'PB-OWNER-EXTRACT', 'PB-MGMT-DEPTH', 'PB-CUST-DIVERSIFY',
]);
const CONTENT = new Set(['CM-EDU-EBITDA-RECAST', 'CM-BUYERQ-OWNER', 'CM-BUYERQ-CONC']);
const ADVISORY = new Set(['AL-BQ-ADDBACKS', 'AL-BQ-OWNER', 'AL-BQ-CONC']);

describe('validateSystemPlans', () => {
  it('the shipped SYSTEM_PLANS validate against their referenced codes', () => {
    expect(validateSystemPlans(SYSTEM_PLANS, PLAYBOOKS, CONTENT, ADVISORY)).toEqual([]);
  });

  it('flags an unknown playbook / content / advisory code', () => {
    const problems = validateSystemPlans(
      [
        {
          code: 'PL-X', name: 'X', summary: 's',
          items: [
            { kind: 'playbook', playbookCode: 'PB-NOPE' },
            { kind: 'education', contentModuleCode: 'CM-NOPE' },
            { kind: 'advisory', advisoryCode: 'AL-NOPE' },
          ],
        },
      ],
      PLAYBOOKS, CONTENT, ADVISORY,
    );
    expect(problems).toHaveLength(3);
    expect(problems.join(' ')).toMatch(/unknown playbook PB-NOPE/);
    expect(problems.join(' ')).toMatch(/unknown content module CM-NOPE/);
    expect(problems.join(' ')).toMatch(/unknown advisory item AL-NOPE/);
  });

  it('flags inline items missing required fields and a plan with no items', () => {
    const problems = validateSystemPlans(
      [
        { code: 'PL-A', name: 'A', summary: 's', items: [
          { kind: 'milestone', title: 'no track here' },      // missing track
          { kind: 'manual_task' },                             // missing title
        ] },
        { code: 'PL-B', name: 'B', summary: 's', items: [] },  // empty
      ],
      PLAYBOOKS, CONTENT, ADVISORY,
    );
    expect(problems.join(' ')).toMatch(/milestone needs track/);
    expect(problems.join(' ')).toMatch(/manual_task needs a title/);
    expect(problems.join(' ')).toMatch(/PL-B: has no items/);
  });

  it('flags a duplicate plan code', () => {
    const dup = { code: 'PL-DUP', name: 'D', summary: 's', items: [
      { kind: 'manual_task' as const, title: 't' },
    ] };
    const problems = validateSystemPlans([dup, dup], PLAYBOOKS, CONTENT, ADVISORY);
    expect(problems.join(' ')).toMatch(/duplicate plan code/);
  });
});
