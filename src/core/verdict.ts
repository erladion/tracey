// Test results in the traceability matrix: which runs the results come from (a release,
// one run, or the latest of each test case), each test case's result in them, and each
// requirement's verdict from its test cases' results.
import { byEvidence, linksOf, type CoveredBy, type Item, type Link, type ProjectIndex } from './model';
import { lastResult, releaseFrom, releaseOf, resultsFor, type CaseResult, type Result, type TestRun } from './runs';

export { releaseOf };

export type ResultSource = { kind: 'none' } | { kind: 'latest' } | { kind: 'release'; key: string } | { kind: 'run'; path: string };

export type Verdict = 'verified' | 'failing' | 'blocked' | 'partial' | 'not-run' | 'no-tests';

export const VERDICTS: Verdict[] = ['verified', 'failing', 'blocked', 'partial', 'not-run', 'no-tests'];

export const VERDICT_LABEL: Record<Verdict, string> = {
  verified: 'Verified',
  failing: 'Failing',
  blocked: 'Blocked',
  partial: 'Partly run',
  'not-run': 'Not run',
  'no-tests': 'No tests',
};

// A mark for each result, so it never depends on colour alone.
export const RESULT_MARK: Record<Result, string> = { passed: '✓', failed: '✕', blocked: '!', 'not-run': '–' };
export const VERDICT_MARK: Record<Verdict, string> = { verified: '✓', failing: '✕', blocked: '!', partial: '–', 'not-run': '–', 'no-tests': '' };

export interface Release {
  key: string; // the version compared loosely: no leading v, lower case (2.4.0)
  name: string; // as written: the code tag, or else the Jira fix version (v2.4.0)
  runs: TestRun[];
}

// Versions match without a leading "v" and ignoring case: v2.4.0, V2.4.0 and 2.4.0 are one.
export const versionKey = (v: string) => v.trim().replace(/^v(?=\d)/i, '').toLowerCase();

const releaseKey = (r: TestRun) => {
  const v = releaseOf(r);
  return v ? versionKey(v) : null;
};

// Runs grouped into releases, newest first.
export function releases(runs: TestRun[]): Release[] {
  const by = new Map<string, TestRun[]>();
  for (const r of runs) {
    const k = releaseKey(r);
    if (k) by.set(k, [...(by.get(k) ?? []), r]);
  }
  const newest = (rs: TestRun[]) => rs.reduce((m, r) => (r.created > m ? r.created : m), '');
  // The name as written: set by hand, else a code tag, else a fix version (the newest run's).
  const pick = (rs: TestRun[], from: string) => rs.map(releaseFrom).find((x) => x?.from === from)?.version;
  const name = (rs: TestRun[]) => pick(rs, 'set') ?? pick(rs, 'code') ?? releaseOf(rs[0])!;
  return [...by].map(([key, rs]) => ({ key, name: name(rs), runs: rs })).sort((a, b) => newest(b.runs).localeCompare(newest(a.runs)) || b.key.localeCompare(a.key));
}

// The runs a source takes its results from; null when it shows none (or no longer exists).
export function sourceRuns(runs: TestRun[], s: ResultSource): TestRun[] | null {
  if (s.kind === 'latest') return runs.length ? runs : null;
  if (s.kind === 'release') {
    const rs = runs.filter((r) => releaseKey(r) === versionKey(s.key));
    return rs.length ? rs : null;
  }
  if (s.kind === 'run') {
    const r = runs.find((x) => x.path === s.path);
    return r ? [r] : null;
  }
  return null;
}

// A short name for the source, for a heading or a column: "Release v2.4.0".
export function sourceName(runs: TestRun[], s: ResultSource): string {
  if (s.kind === 'latest') return 'Latest results';
  if (s.kind === 'release') return `Release ${releases(runs).find((r) => r.key === versionKey(s.key))?.name ?? s.key}`;
  if (s.kind === 'run') return `Test run ${runs.find((r) => r.path === s.path)?.name ?? s.path}`;
  return 'No results';
}

// A sentence on where the results come from: "the last result of each test case in the
// 3 test runs for release v2.4.0 (Smoke, Regression, Pro), 21 Oct to 30 Oct".
export function describeSource(runs: TestRun[], s: ResultSource): string {
  const rs = sourceRuns(runs, s);
  if (!rs) return 'no test results';
  const dates = rs.map((r) => r.created).filter(Boolean).sort();
  const span = dates.length ? (dates[0] === dates[dates.length - 1] ? `, ${dates[0]}` : `, ${dates[0]} to ${dates[dates.length - 1]}`) : '';
  const names = rs.map((r) => r.name).join(', ');
  if (s.kind === 'run') return `the test run “${rs[0].name}”${span}`;
  const n = rs.length === 1 ? 'the test run' : `the ${rs.length} test runs`;
  if (s.kind === 'release') return `the last result of each test case in ${n} for release ${releases(runs).find((r) => r.key === versionKey(s.key))?.name ?? s.key} (${names})${span}`;
  return `the last result of each test case across ${rs.length === 1 ? 'the only test run' : `the ${rs.length} test runs`}${span}`;
}

export interface Outcome {
  result: Result;
  at: CaseResult | null; // where the result was recorded
  inRuns: boolean; // false: the test case isn't in any of the runs
}

// A test case's result in these runs: its newest recorded result; not run when it
// hasn't been run in them, or isn't in them at all.
export function outcome(runs: TestRun[], id: string): Outcome {
  const at = lastResult(runs, id);
  if (at) return { result: at.case.result, at, inRuns: true };
  return { result: 'not-run', at: null, inRuns: resultsFor(runs, id).length > 0 };
}

// Failing if any test case failed, else blocked if any is blocked; verified when all
// passed, partly run when some passed and the rest haven't run.
export function verdictOf(results: Result[]): Verdict {
  if (!results.length) return 'no-tests';
  if (results.includes('failed')) return 'failing';
  if (results.includes('blocked')) return 'blocked';
  const passed = results.filter((r) => r === 'passed').length;
  return passed === results.length ? 'verified' : passed ? 'partial' : 'not-run';
}

// A requirement verified through its refinements: the verdicts of the requirements
// refining it, the worst first. Any without tests leaves it without (as coverage says);
// then failing, blocked; verified when all are; partly when some are.
export function combineVerdicts(vs: Verdict[]): Verdict {
  for (const v of ['no-tests', 'failing', 'blocked'] as Verdict[]) if (vs.includes(v)) return v;
  if (vs.every((v) => v === 'verified')) return 'verified';
  return vs.some((v) => v === 'verified' || v === 'partial') ? 'partial' : 'not-run';
}

export interface MatrixRow {
  req: Item;
  links: (Link & { outcome: Outcome })[];
  verdict: Verdict | null; // null: obsolete, or needing no verification (verification: none)
  via: CoveredBy | null; // where the verdict comes from: its own test cases, its evidence, or its refinements
  through: Item[]; // via refinements: the ones deciding the verdict (all of them when verified)
}

// Every requirement kept, with its test cases' results and its verdict. Obsolete test
// cases are listed but don't count toward the verdict. A requirement without test cases
// of its own takes its verdict from its evidence, or else from the requirements refining it.
export function resultMatrix(index: ProjectIndex, runs: TestRun[], keep: (i: Item) => boolean = () => true): MatrixRow[] {
  const rows = new Map<string, MatrixRow>();
  const visiting = new Set<string>();
  const row = (req: Item): MatrixRow => {
    const known = rows.get(req.id);
    if (known) return known;
    const links = linksOf(index, req)
      .filter((l) => keep(l.test))
      .map((l) => ({ ...l, outcome: outcome(runs, l.test.id) }));
    const out: MatrixRow = { req, links, verdict: null, via: null, through: [] };
    if (visiting.has(req.id)) return { ...out, verdict: 'no-tests' }; // a loop verifies nothing
    const counted = links.filter((l) => l.test.status !== 'obsolete').map((l) => l.outcome.result);
    if (req.status === 'obsolete') {
      // Needs no verdict.
    } else if (counted.length) Object.assign(out, { verdict: verdictOf(counted), via: 'tests' });
    else if (byEvidence(req.verification) && req.evidence.length) Object.assign(out, { verdict: 'verified', via: 'evidence' });
    else {
      visiting.add(req.id);
      const below = (index.refinedBy.get(req.id) ?? []).filter((c) => c.status !== 'obsolete').map(row).filter((r) => r.verdict);
      visiting.delete(req.id);
      if (below.length) {
        const v = combineVerdicts(below.map((r) => r.verdict!));
        Object.assign(out, { verdict: v, via: 'refinements', through: below.filter((r) => v === 'verified' || r.verdict === v || (v === 'partial' && r.verdict !== 'verified')).map((r) => r.req) });
      } else if (req.verification !== 'none') out.verdict = 'no-tests';
    }
    rows.set(req.id, out);
    return out;
  };
  return index.items.filter((i) => i.kind === 'requirement' && keep(i)).map(row);
}

// The verdict with where it comes from: "Failing (via REQ-3)", "Verified (analysis)".
export function verdictText(r: MatrixRow): string {
  if (!r.verdict) return r.req.status !== 'obsolete' && r.req.verification === 'none' ? 'None needed' : '';
  const label = r.verdict === 'no-tests' && byEvidence(r.req.verification) && !r.through.length ? 'No evidence' : VERDICT_LABEL[r.verdict];
  if (r.via === 'evidence') return `${label} (${r.req.verification})`;
  if (r.via === 'refinements') return `${label} (via ${r.through.map((i) => i.id).join(', ')})`;
  return label;
}

export function verdictCounts(rows: MatrixRow[]): Record<Verdict, number> {
  const out = Object.fromEntries(VERDICTS.map((v) => [v, 0])) as Record<Verdict, number>;
  for (const r of rows) if (r.verdict) out[r.verdict]++;
  return out;
}

// "2 of 7 requirements verified · 1 failing · 2 blocked · 1 not covered"
export function verdictSummary(rows: MatrixRow[]): string {
  const c = verdictCounts(rows);
  const total = rows.filter((r) => r.verdict).length;
  const rest = (['failing', 'blocked', 'partial', 'not-run', 'no-tests'] as Verdict[])
    .filter((v) => c[v])
    .map((v) => `${c[v]} ${v === 'no-tests' ? 'not covered' : VERDICT_LABEL[v].toLowerCase()}`);
  return [`${c.verified} of ${total} requirement${total === 1 ? '' : 's'} verified`, ...rest].join(' · ');
}

// A test case's result as text: "passed", "not run", "not in the run".
export function outcomeText(o: Outcome, oneRun = false): string {
  if (o.result !== 'not-run') return o.result;
  return o.inRuns ? 'not run' : oneRun ? 'not in the run' : 'not in the runs';
}
