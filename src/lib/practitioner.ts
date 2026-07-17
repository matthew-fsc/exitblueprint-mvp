// Practitioner-workflow lenses (docs/18): present data the platform already has
// in the vocabulary CEPAs actually use — the Four Intangible Capitals and the
// 90-day sprint cadence of the Prepare gate. Pure and deterministic; unit-tested
// in tests/practitioner.test.ts. No scoring or schema change — these read scores
// and tasks that already exist.

// ---- Four Intangible Capitals -----------------------------------------------
// The EPI frames ~80% of enterprise value as four non-financial capitals. Our
// six business dimensions roll up into them: a lens, not a new score.

export interface DimensionScore {
  code: string;
  name: string;
  score: number;
}

export interface Capital {
  key: 'human' | 'structural' | 'customer' | 'social';
  label: string;
  blurb: string;
  score: number | null; // null when no member dimension is present
  members: string[]; // dimension codes that rolled in
}

const CAPITAL_MAP: { key: Capital['key']; label: string; blurb: string; dims: string[] }[] = [
  { key: 'human', label: 'Human', blurb: 'Leadership, management depth, and culture.', dims: ['MGT'] },
  { key: 'structural', label: 'Structural', blurb: 'Systems, SOPs, automation, and financial rigor.', dims: ['OPS', 'FIN'] },
  { key: 'customer', label: 'Customer', blurb: 'Revenue durability and customer relationships.', dims: ['CUS', 'REV'] },
  { key: 'social', label: 'Social', blurb: 'Brand, positioning, and market reputation.', dims: ['GRW'] },
];

/**
 * Roll the six business dimensions into the four intangible capitals (equal
 * weight within each capital — a readable lens, deliberately not a re-scoring).
 */
export function rollUpCapitals(dimensions: DimensionScore[]): Capital[] {
  const byCode = new Map(dimensions.map((d) => [d.code, d]));
  return CAPITAL_MAP.map((c) => {
    const present = c.dims.map((code) => byCode.get(code)).filter((d): d is DimensionScore => !!d);
    const score = present.length
      ? Math.round((present.reduce((s, d) => s + d.score, 0) / present.length) * 10) / 10
      : null;
    return { key: c.key, label: c.label, blurb: c.blurb, score, members: present.map((d) => d.code) };
  });
}

// ---- 90-day sprints ---------------------------------------------------------
// The Prepare gate runs in 90-day sprints. Group open roadmap tasks into the
// sprint windows a CEPA would plan against, from a reference "today".

export interface SprintTask {
  due_date: string | null;
  status: string;
}

export interface Sprint<T extends SprintTask> {
  key: string;
  label: string;
  tasks: T[];
}

const DAY = 86_400_000;

/**
 * Bucket open tasks (status !== 'done') into 90-day sprint windows measured from
 * `todayISO`. Overdue and near-term work lands in "This sprint"; undated work in
 * "Unscheduled". Only non-empty buckets are returned, in chronological order.
 */
export function groupIntoSprints<T extends SprintTask>(tasks: T[], todayISO: string): Sprint<T>[] {
  const today = new Date(todayISO).getTime();
  const windows: { key: string; label: string; maxDay: number | null }[] = [
    { key: 's1', label: 'This sprint · next 90 days', maxDay: 90 },
    { key: 's2', label: 'Sprint 2 · 90–180 days', maxDay: 180 },
    { key: 's3', label: 'Sprint 3 · 180–270 days', maxDay: 270 },
    { key: 'later', label: 'Later · 270+ days', maxDay: null },
  ];
  const buckets = new Map<string, T[]>([...windows.map((w) => [w.key, [] as T[]] as const), ['unscheduled', []]]);

  for (const t of tasks) {
    if (t.status === 'done') continue;
    if (!t.due_date) {
      buckets.get('unscheduled')!.push(t);
      continue;
    }
    const days = Math.floor((new Date(t.due_date).getTime() - today) / DAY);
    const w = windows.find((win) => win.maxDay != null && days < win.maxDay) ?? windows[windows.length - 1];
    buckets.get(w.key)!.push(t);
  }

  const ordered: Sprint<T>[] = windows.map((w) => ({ key: w.key, label: w.label, tasks: buckets.get(w.key)! }));
  ordered.push({ key: 'unscheduled', label: 'Unscheduled', tasks: buckets.get('unscheduled')! });
  return ordered.filter((s) => s.tasks.length > 0);
}
