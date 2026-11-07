// Test runs: one YAML file each, in the requirements repository (test-runs/).
//
//   name: Release 2.4.0
//   created: 2026-11-06
//   variant: pro                   (when the project has variants)
//   code: { from: v2.3.0, to: v2.4.0, tag: true, commit: 3f2a…, commits: 42 }   (tag: `to` is a tag)
//   requirements-commit: 9c1e…
//   issues: [PROJ-466, PROJ-481]
//   gaps: { requirements-without-tests: [REQ-19], … }
//   cases:
//
//     TC-101:
//       result: passed
//       tester: Ana
//       date: 2026-11-07
//       reason: [PROJ-466 → REQ-07 (2 commits)]
//
// Each case is its own block with a blank line before it, so two testers recording
// different cases in the same run change separate parts of the file and git merges
// them without conflicts. Changes go through the YAML document, so the rest of the
// file stays as it was.
import { parseDocument, isMap, isScalar, isSeq, type Document, type YAMLMap, type Pair } from 'yaml';
import { slug } from './model';

export const RESULTS = ['passed', 'failed', 'blocked', 'not-run'] as const;
export type Result = (typeof RESULTS)[number];

export interface RunCase {
  id: string;
  result: Result;
  tester: string;
  date: string;
  note: string;
  reason: string[];
}

export interface RunGaps {
  requirementsWithoutTests: string[];
  componentsWithoutTests: string[];
  issuesWithoutRequirement: string[];
}

export interface TestRun {
  path: string;
  name: string;
  created: string;
  from: string | null;
  to: string | null;
  toTag: boolean | null; // whether `to` is a tag in the code repository; null: not recorded
  codeCommit: string | null;
  commitCount: number | null;
  requirementsCommit: string | null;
  fixVersion: string | null; // Jira fix version the run covers
  variant: string | null; // the product variant tested; null: not said
  issues: string[];
  gaps: RunGaps;
  cases: RunCase[];
  error: string | null;
}

const str = (v: unknown) => (v == null ? '' : String(v));
const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : v == null || v === '' ? [] : [String(v)]);

export function readRun(path: string, text: string): TestRun {
  const doc = parseDocument(text);
  const run: TestRun = {
    path,
    name: path.replace(/^.*\//, '').replace(/\.ya?ml$/i, ''),
    created: '',
    from: null,
    to: null,
    toTag: null,
    codeCommit: null,
    commitCount: null,
    requirementsCommit: null,
    fixVersion: null,
    variant: null,
    issues: [],
    gaps: { requirementsWithoutTests: [], componentsWithoutTests: [], issuesWithoutRequirement: [] },
    cases: [],
    error: null,
  };
  if (doc.errors.length) return { ...run, error: doc.errors[0].message.split('\n')[0] };
  const o = (doc.toJS() ?? {}) as Record<string, unknown>;
  const code = (o.code ?? {}) as Record<string, unknown>;
  const gaps = (o.gaps ?? {}) as Record<string, unknown>;
  const cases = (o.cases ?? {}) as Record<string, Record<string, unknown> | null>;
  return {
    ...run,
    name: str(o.name) || run.name,
    created: str(o.created),
    from: code.from == null ? null : str(code.from),
    to: code.to == null ? null : str(code.to),
    toTag: typeof code.tag === 'boolean' ? code.tag : null,
    codeCommit: code.commit == null ? null : str(code.commit),
    commitCount: code.commits == null ? null : Number(code.commits),
    requirementsCommit: o['requirements-commit'] == null ? null : str(o['requirements-commit']),
    fixVersion: (o.jira as Record<string, unknown> | undefined)?.['fix-version'] == null ? null : str((o.jira as Record<string, unknown>)['fix-version']),
    variant: o.variant == null || o.variant === '' ? null : str(o.variant),
    issues: list(o.issues),
    gaps: {
      requirementsWithoutTests: list(gaps['requirements-without-tests']),
      componentsWithoutTests: list(gaps['components-without-tests']),
      issuesWithoutRequirement: list(gaps['issues-without-requirement']),
    },
    cases: Object.entries(cases && typeof cases === 'object' ? cases : {}).map(([id, c]) => {
      const r = str(c?.result) as Result;
      return {
        id,
        result: RESULTS.includes(r) ? r : 'not-run',
        tester: str(c?.tester),
        date: str(c?.date),
        note: str(c?.note),
        reason: list(c?.reason),
      };
    }),
  };
}

export interface NewRun {
  name: string;
  created: string;
  from: string | null;
  to: string | null;
  toTag?: boolean | null;
  codeCommit: string | null;
  commitCount: number | null;
  requirementsCommit: string | null;
  fixVersion?: string | null;
  variant?: string | null;
  issues: string[];
  gaps: RunGaps;
  cases: { id: string; reason: string[] }[];
}

function flowLists(doc: Document) {
  const flow = (n: unknown) => {
    if (isSeq(n)) n.flow = true;
  };
  flow(doc.get('issues', true));
  const g = doc.get('gaps', true);
  if (isMap(g)) for (const p of g.items as Pair[]) flow(p.value);
  const cases = doc.get('cases', true);
  if (isMap(cases)) for (const p of cases.items as Pair[]) if (isMap(p.value)) flow(p.value.get('reason', true));
}

function spaceCases(doc: Document) {
  const cases = doc.get('cases', true);
  if (isMap(cases)) ((cases as YAMLMap).items as Pair[]).forEach((pair, i) => isScalar(pair.key) && (pair.key.spaceBefore = i > 0));
}

export function newRunText(r: NewRun): string {
  const doc = parseDocument('{}');
  const obj: Record<string, unknown> = { name: r.name, created: r.created };
  if (r.variant) obj.variant = r.variant;
  if (r.from || r.to) obj.code = { from: r.from, to: r.to, ...(r.to && r.toTag != null ? { tag: r.toTag } : {}), commit: r.codeCommit, commits: r.commitCount };
  if (r.requirementsCommit) obj['requirements-commit'] = r.requirementsCommit;
  if (r.fixVersion) obj.jira = { 'fix-version': r.fixVersion };
  if (r.issues.length) obj.issues = r.issues;
  const gaps: Record<string, string[]> = {};
  if (r.gaps.requirementsWithoutTests.length) gaps['requirements-without-tests'] = r.gaps.requirementsWithoutTests;
  if (r.gaps.componentsWithoutTests.length) gaps['components-without-tests'] = r.gaps.componentsWithoutTests;
  if (r.gaps.issuesWithoutRequirement.length) gaps['issues-without-requirement'] = r.gaps.issuesWithoutRequirement;
  if (Object.keys(gaps).length) obj.gaps = gaps;
  obj.cases = Object.fromEntries(r.cases.map((c) => [c.id, c.reason.length ? { result: 'not-run', reason: c.reason } : { result: 'not-run' }]));
  doc.contents = doc.createNode(obj) as never;
  // Short lists on one line; cases and their fields as blocks.
  flowLists(doc);
  spaceCases(doc);
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false });
}

// Changes one case's fields (empty removes a field).
export function setCase(text: string, id: string, changes: Partial<Pick<RunCase, 'result' | 'tester' | 'date' | 'note'>>): string {
  const doc = parseDocument(text);
  if (!doc.hasIn(['cases', id])) doc.setIn(['cases', id], doc.createNode({ result: 'not-run' }));
  for (const [k, v] of Object.entries(changes)) {
    if (v == null || v === '') doc.deleteIn(['cases', id, k]);
    else doc.setIn(['cases', id, k], v);
  }
  spaceCases(doc);
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false });
}

export function addCases(text: string, cases: { id: string; reason: string[] }[]): string {
  const doc = parseDocument(text);
  if (!isMap(doc.get('cases', true))) doc.set('cases', doc.createNode({}));
  for (const c of cases) {
    if (doc.hasIn(['cases', c.id])) continue;
    doc.setIn(['cases', c.id], doc.createNode(c.reason.length ? { result: 'not-run', reason: c.reason } : { result: 'not-run' }));
  }
  flowLists(doc);
  spaceCases(doc);
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false });
}

// Replaces top-level fields and whole cases (null removes), keeping everything else as
// written. For merging.
export function patchRun(text: string, top: Record<string, unknown>, cases: Record<string, Record<string, unknown> | null>): string {
  const doc = parseDocument(text);
  for (const [k, v] of Object.entries(top)) {
    if (v === undefined || v === null) doc.delete(k);
    else doc.set(k, doc.createNode(v));
  }
  if (Object.keys(cases).length && !isMap(doc.get('cases', true))) doc.set('cases', doc.createNode({}));
  for (const [id, c] of Object.entries(cases)) {
    if (c == null) doc.deleteIn(['cases', id]);
    else doc.setIn(['cases', id], doc.createNode(c));
  }
  flowLists(doc);
  spaceCases(doc);
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false });
}

export function removeCase(text: string, id: string): string {
  const doc = parseDocument(text);
  doc.deleteIn(['cases', id]);
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false });
}

export interface RunSummary {
  total: number;
  passed: number;
  failed: number;
  blocked: number;
  notRun: number;
  done: number; // passed + failed + blocked
}

export function summarize(run: TestRun): RunSummary {
  const n = (r: Result) => run.cases.filter((c) => c.result === r).length;
  const s = { total: run.cases.length, passed: n('passed'), failed: n('failed'), blocked: n('blocked'), notRun: n('not-run') };
  return { ...s, done: s.passed + s.failed + s.blocked };
}

export function runPath(dir: string, name: string, existing: Set<string>): string {
  const base = `${dir}/${slug(name) || 'test-run'}`;
  let p = `${base}.yml`;
  for (let i = 2; existing.has(p); i++) p = `${base}-${i}.yml`;
  return p;
}

export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export interface CaseResult {
  run: TestRun;
  case: RunCase;
}

// Every run a test case is in, as the runs are listed (newest first).
export function resultsFor(runs: TestRun[], id: string): CaseResult[] {
  const out: CaseResult[] = [];
  for (const run of runs) {
    const c = run.cases.find((x) => x.id === id);
    if (c) out.push({ run, case: c });
  }
  return out;
}

// The last time a test case was run: the newest recorded result, by the date it was
// recorded (or the run's date), not counting runs where it hasn't been run yet.
export function lastResult(runs: TestRun[], id: string): CaseResult | null {
  let best: CaseResult | null = null;
  for (const r of resultsFor(runs, id)) {
    if (r.case.result === 'not-run') continue;
    if (!best || (r.case.date || r.run.created) > (best.case.date || best.run.created)) best = r;
  }
  return best;
}
