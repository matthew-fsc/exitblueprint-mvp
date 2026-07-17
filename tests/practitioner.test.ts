import { describe, expect, it } from 'vitest';
import { rollUpCapitals, groupIntoSprints } from '../src/lib/practitioner';

describe('rollUpCapitals', () => {
  const dims = [
    { code: 'REV', name: 'Revenue Quality', score: 80 },
    { code: 'FIN', name: 'Financial Integrity', score: 70 },
    { code: 'OPS', name: 'Operational Independence', score: 60 },
    { code: 'CUS', name: 'Customer Risk', score: 90 },
    { code: 'MGT', name: 'Management', score: 50 },
    { code: 'GRW', name: 'Growth', score: 40 },
  ];
  it('rolls six dimensions into four capitals', () => {
    const c = rollUpCapitals(dims);
    const by = Object.fromEntries(c.map((x) => [x.key, x]));
    expect(by.human.score).toBe(50); // MGT
    expect(by.structural.score).toBe(65); // (OPS 60 + FIN 70)/2
    expect(by.customer.score).toBe(85); // (CUS 90 + REV 80)/2
    expect(by.social.score).toBe(40); // GRW
    expect(by.structural.members).toEqual(['OPS', 'FIN']);
  });
  it('handles a missing dimension → null score', () => {
    const c = rollUpCapitals(dims.filter((d) => d.code !== 'MGT'));
    expect(c.find((x) => x.key === 'human')!.score).toBeNull();
    expect(c.find((x) => x.key === 'human')!.members).toEqual([]);
  });
});

describe('groupIntoSprints', () => {
  const today = '2026-07-01T00:00:00Z';
  const mk = (d: string | null, status = 'todo') => ({ due_date: d, status });

  it('buckets tasks into 90-day windows and drops empty ones', () => {
    const tasks = [
      mk('2026-06-15'), // overdue → this sprint
      mk('2026-08-01'), // ~31d → this sprint
      mk('2026-10-15'), // ~106d → sprint 2
      mk('2027-06-01'), // ~335d → later
      mk(null), // unscheduled
    ];
    const s = groupIntoSprints(tasks, today);
    const labels = s.map((x) => x.key);
    expect(labels).toEqual(['s1', 's2', 'later', 'unscheduled']); // s3 empty → dropped
    expect(s.find((x) => x.key === 's1')!.tasks.length).toBe(2);
    expect(s.find((x) => x.key === 'unscheduled')!.tasks.length).toBe(1);
  });

  it('excludes done tasks', () => {
    const s = groupIntoSprints([mk('2026-08-01', 'done'), mk('2026-08-02', 'todo')], today);
    expect(s.reduce((n, x) => n + x.tasks.length, 0)).toBe(1);
  });

  it('returns nothing when all tasks are done or absent', () => {
    expect(groupIntoSprints([mk('2026-08-01', 'done')], today)).toEqual([]);
    expect(groupIntoSprints([], today)).toEqual([]);
  });
});
