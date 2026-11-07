// The repository as spreadsheet tables: requirements, test cases, the traceability
// matrix, test runs and their results, and coverage over time.
import { linksOf, variantNames, type Item, type LinkState, type ProjectIndex } from './model';
import { lastResult, releaseOf, summarize, type TestRun } from './runs';
import type { TrendPoint } from './trend';
import { outcomeText, resultMatrix, VERDICT_LABEL, type Outcome, type Verdict } from './verdict';
import type { Cell, Sheet, Tone } from './xlsx';

export interface TableOptions {
  obsolete: boolean; // include obsolete items
  component: string | null; // only items tagged with it
  runs: TestRun[];
  issues?: (item: Item) => string[]; // Jira issues linked to an item (default: its front matter)
  trend?: TrendPoint[] | null;
  // Show test results in the matrix: from these runs (see verdict.ts).
  results?: { runs: TestRun[]; name: string; oneRun: boolean } | null;
}

export type TableKey = 'requirements' | 'testcases' | 'matrix' | 'runs' | 'results' | 'trend';

export const TABLE_LABEL: Record<TableKey, string> = {
  requirements: 'Requirements',
  testcases: 'Test cases',
  matrix: 'Traceability matrix',
  runs: 'Test runs',
  results: 'Test results',
  trend: 'Coverage over time',
};

const STATE_LABEL: Record<LinkState, string> = { ok: 'reviewed', suspect: 'changed since review', unreviewed: 'not reviewed' };
const MATRIX_MARK: Record<LinkState, string> = { ok: '✓', suspect: 'changed', unreviewed: 'not reviewed' };
const RESULT_TONE: Record<Outcome['result'], Tone> = { passed: 'good', failed: 'bad', blocked: 'warn', 'not-run': 'muted' };
const VERDICT_TONE: Record<Verdict, Tone> = { verified: 'good', failing: 'bad', blocked: 'warn', partial: 'muted', 'not-run': 'muted', 'no-tests': 'bad' };

export function tables(index: ProjectIndex, o: TableOptions): Record<TableKey, Sheet> {
  const keep = (i: Item) => (o.obsolete || i.status !== 'obsolete') && (!o.component || i.components.includes(o.component));
  const reqs = index.items.filter((i) => i.kind === 'requirement' && keep(i));
  const tests = index.items.filter((i) => i.kind === 'testcase' && keep(i));
  const issues = (it: Item) => (o.issues ? o.issues(it) : it.jira).join(', ');
  const componentNames = (it: Item) => it.components.map((c) => index.config.components.find((x) => x.key === c)?.name ?? c).join(', ');
  const last = (id: string) => lastResult(o.runs, id);
  // Runs: only the cases kept.
  const runCases = (r: TestRun) => r.cases.filter((c) => !index.byId.has(c.id) || keep(index.byId.get(c.id)!));

  const requirements: Sheet = {
    name: 'Requirements',
    columns: [
      { header: 'ID', width: 10 },
      { header: 'Title', width: 40, wrap: true },
      { header: 'Status', width: 11 },
      { header: 'Variants', width: 16 },
      { header: 'Components', width: 16 },
      { header: 'Jira', width: 16 },
      { header: 'Test cases', width: 18, wrap: true },
      { header: 'Covered', width: 9 },
      { header: 'To review', width: 18, wrap: true },
      { header: 'Last results', width: 36, wrap: true },
      { header: 'File', width: 36 },
    ],
    rows: reqs.map((r) => {
      const links = linksOf(index, r).filter((l) => keep(l.test));
      const covered = links.some((l) => l.test.status !== 'obsolete');
      return [
        r.id,
        r.title,
        r.status,
        variantNames(index.config, r),
        componentNames(r),
        issues(r),
        links.map((l) => l.test.id).join(', '),
        r.status === 'obsolete' ? '' : covered ? 'Yes' : 'No',
        links
          .filter((l) => l.state === 'suspect')
          .map((l) => l.test.id)
          .join(', '),
        links
          .map((l) => {
            const res = last(l.test.id);
            return `${l.test.id}: ${res ? `${res.case.result} (${res.run.name})` : 'never run'}`;
          })
          .join('\n'),
        r.path,
      ];
    }),
  };

  const testcases: Sheet = {
    name: 'Test cases',
    columns: [
      { header: 'ID', width: 10 },
      { header: 'Title', width: 40, wrap: true },
      { header: 'Status', width: 11 },
      { header: 'Verifies', width: 18, wrap: true },
      { header: 'Links', width: 30, wrap: true },
      { header: 'Variants', width: 16 },
      { header: 'Components', width: 16 },
      { header: 'Jira', width: 16 },
      { header: 'Last result', width: 12 },
      { header: 'Last run', width: 22 },
      { header: 'Tester', width: 16 },
      { header: 'Date', width: 11 },
      { header: 'Note', width: 40, wrap: true },
      { header: 'File', width: 36 },
    ],
    rows: tests.map((t) => {
      const res = last(t.id);
      return [
        t.id,
        t.title,
        t.status,
        t.verifies.join(', '),
        linksOf(index, t)
          .map((l) => `${l.req.id}: ${STATE_LABEL[l.state]}`)
          .join('\n'),
        variantNames(index.config, t),
        componentNames(t),
        issues(t),
        res?.case.result ?? 'never run',
        res?.run.name ?? '',
        res?.case.tester ?? '',
        res ? res.case.date || res.run.created : '',
        res?.case.note ?? '',
        t.path,
      ];
    }),
  };

  // Requirements down, the test cases that verify one across. With results: each
  // requirement's verdict, and each test case's result in the chosen runs.
  const linked = tests.filter((t) => t.verifies.some((v) => reqs.some((r) => r.id === v)));
  const res = o.results;
  const rows = resultMatrix(index, res?.runs ?? [], keep);
  const matrix: Sheet = {
    name: 'Matrix',
    columns: [
      { header: 'Requirement', width: 10 },
      { header: 'Title', width: 36 },
      ...(res ? [{ header: `Verdict (${res.name})`, width: Math.max(12, res.name.length + 11) }] : []),
      ...linked.map((t) => ({ header: t.id, width: Math.max(res ? 12 : 9, t.id.length + 3) })),
    ],
    rows: rows.map(({ req, links, verdict }) => {
      const by = new Map(links.map((l) => [l.test.id, l]));
      const cells: Cell[] = linked.map((t) => {
        const l = by.get(t.id);
        if (!l) return null;
        if (!res) return MATRIX_MARK[l.state];
        return { text: outcomeText(l.outcome, res.oneRun) + (l.state === 'suspect' ? ' ⚠' : ''), tone: RESULT_TONE[l.outcome.result] };
      });
      return [req.id, req.title, ...(res ? [verdict ? ({ text: VERDICT_LABEL[verdict], tone: VERDICT_TONE[verdict] } as Cell) : null] : []), ...cells];
    }),
  };

  const runs: Sheet = {
    name: 'Test runs',
    columns: [
      { header: 'Run', width: 24 },
      { header: 'Created', width: 11 },
      { header: 'Release', width: 10 },
      { header: 'From', width: 10 },
      { header: 'To', width: 10 },
      { header: 'Fix version', width: 11 },
      { header: 'Variant', width: 12 },
      { header: 'Test cases', width: 10 },
      { header: 'Passed', width: 8 },
      { header: 'Failed', width: 8 },
      { header: 'Blocked', width: 8 },
      { header: 'Not run', width: 8 },
      { header: 'Done', width: 8 },
      { header: 'File', width: 32 },
    ],
    rows: o.runs.map((r) => {
      const s = summarize({ ...r, cases: runCases(r) });
      return [r.name, r.created, releaseOf(r), r.from, r.to, r.fixVersion, r.variant ? (index.config.variants.find((v) => v.key === r.variant)?.name ?? r.variant) : null, s.total, s.passed, s.failed, s.blocked, s.notRun, s.total ? { pct: s.done / s.total } : null, r.path];
    }),
  };

  const results: Sheet = {
    name: 'Test results',
    columns: [
      { header: 'Run', width: 24 },
      { header: 'Created', width: 11 },
      { header: 'Test case', width: 10 },
      { header: 'Title', width: 36, wrap: true },
      { header: 'Verifies', width: 16 },
      { header: 'Result', width: 9 },
      { header: 'Tester', width: 16 },
      { header: 'Date', width: 11 },
      { header: 'Note', width: 40, wrap: true },
      { header: 'Why it was picked', width: 40, wrap: true },
    ],
    rows: o.runs.flatMap((r) =>
      runCases(r).map((c) => {
        const it = index.byId.get(c.id);
        return [r.name, r.created, c.id, it?.title ?? '(no longer in the repository)', it?.verifies.join(', ') ?? '', c.result, c.tester, c.date, c.note, c.reason.join('\n')];
      }),
    ),
  };

  const trend: Sheet = {
    name: 'Coverage over time',
    columns: [
      { header: 'Date', width: 11 },
      { header: 'Run', width: 24 },
      { header: 'Code version', width: 12 },
      { header: 'Requirements', width: 13 },
      { header: 'With test cases', width: 15 },
      { header: 'Covered', width: 9 },
      { header: 'Links to review', width: 15 },
      { header: 'Passed', width: 8 },
      { header: 'Failed', width: 8 },
      { header: 'Blocked', width: 8 },
      { header: 'Not run', width: 8 },
      { header: 'Requirements passing', width: 20 },
    ],
    rows: (o.trend ?? []).map((p) => [
      p.date,
      p.label,
      p.version,
      p.coverage?.requirements ?? null,
      p.coverage?.tested ?? null,
      p.coverage ? { pct: p.coverage.requirements ? p.coverage.tested / p.coverage.requirements : 0 } : null,
      p.coverage?.suspect ?? null,
      p.results?.passed ?? null,
      p.results?.failed ?? null,
      p.results?.blocked ?? null,
      p.results?.notRun ?? null,
      p.passing,
    ]),
  };

  return { requirements, testcases, matrix, runs, results, trend };
}
