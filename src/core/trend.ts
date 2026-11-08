// Coverage and results over time: one point per test run (oldest first), with the
// requirements as they were when the run was created (its requirements-commit), and a
// last point for now.
import { coverage, type ProjectIndex } from './model';
import { summarize, today, type RunSummary, type TestRun } from './runs';

export interface CoverageCounts {
  requirements: number; // not obsolete, and needing verification
  tested: number; // covered: by a test case, by evidence, or through refinements
  suspect: number; // links to review: the requirement changed since
}

export interface TrendPoint {
  label: string; // the run's name, or "Now"
  date: string;
  run: TestRun | null; // null: now
  version: string | null; // the code version the run tested
  coverage: CoverageCounts | null; // null: the requirements at that time couldn't be read
  results: RunSummary | null; // null: now
  // Requirements with a passing test in the run and no failed or blocked one.
  passing: number | null;
}

export function coverageCounts(index: ProjectIndex): CoverageCounts {
  const c = coverage(index);
  return { requirements: c.counted.length, tested: c.tested.length, suspect: c.suspect.length };
}

export function passingRequirements(run: TestRun, index: ProjectIndex): number {
  const result = new Map(run.cases.map((c) => [c.id, c.result]));
  let n = 0;
  for (const r of index.items) {
    if (r.kind !== 'requirement' || r.status === 'obsolete') continue;
    const got = (index.verifiedBy.get(r.id) ?? []).map((t) => result.get(t.id)).filter((x) => x != null);
    if (got.includes('passed') && !got.includes('failed') && !got.includes('blocked')) n++;
  }
  return n;
}

export const pct = (c: CoverageCounts) => (c.requirements ? Math.round((c.tested / c.requirements) * 100) : 0);

// `at(run)`: the requirements when the run was made, or null if unknown.
export function trend(runs: TestRun[], at: (run: TestRun) => ProjectIndex | null, now: ProjectIndex, date = today()): TrendPoint[] {
  const ordered = [...runs].sort((a, b) => (a.created || '').localeCompare(b.created || '') || a.path.localeCompare(b.path));
  const points: TrendPoint[] = ordered.map((run) => {
    const index = at(run);
    return {
      label: run.name,
      date: run.created,
      run,
      version: run.to,
      coverage: index ? coverageCounts(index) : null,
      results: summarize(run),
      passing: index ? passingRequirements(run, index) : null,
    };
  });
  points.push({ label: 'Now', date, run: null, version: null, coverage: coverageCounts(now), results: null, passing: null });
  return points;
}
