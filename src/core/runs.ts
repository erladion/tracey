// Test runs: one YAML file each, in the requirements repository (test-runs/).
//
//   name: Release 2.4.0
//   created: 2026-11-06
//   release: v2.4.0                (optional: the release its results count toward)
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
//       assignee: Ana                  (who's to run it)
//       steps: { 1: passed, 2: failed } (per step of the test case's Steps list)
//       step-notes:
//         2: Stops after 2 retries.
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
  note: string; // may span lines
  reason: string[];
  assignee: string; // who's to run it; empty: nobody yet
  steps: Record<number, Result>; // per step (1, 2…), when recorded step by step
  stepNotes: Record<number, string>;
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
  release: string | null; // the release it's for, when set by hand (see releaseOf)
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
// { 1: x, 2: y } with step numbers as keys; anything else is left out.
function numbered<T>(v: unknown, read: (x: unknown) => T | null): Record<number, T> {
  const out: Record<number, T> = {};
  if (v && typeof v === 'object' && !Array.isArray(v))
    for (const [k, x] of Object.entries(v)) {
      const n = Number(k);
      const r = read(x);
      if (Number.isInteger(n) && n > 0 && r != null) out[n] = r;
    }
  return out;
}
const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : v == null || v === '' ? [] : [String(v)]);

// ---- case blocks ------------------------------------------------------------------------
// A run with thousands of cases is a big file. As Tracey writes it, each case is a block
// of its own under `cases:` (its ID at two spaces, its fields deeper), so a result is
// saved by changing that block alone, and reading the file again parses only the blocks
// that changed. A file laid out otherwise is read and written whole.

interface Blocks {
  lines: string[];
  head: string; // the file with an empty cases section
  blocks: { id: string; from: number; to: number }[]; // line ranges, `to` exclusive, without trailing blank lines
}

const CASE_KEY = /^ {2}([A-Za-z0-9][\w.-]*):\s*$/;

function caseBlocks(text: string): Blocks | null {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^cases:\s*$/.test(l));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++)
    if (/^\S/.test(lines[i])) {
      end = i;
      break;
    }
  const blocks: Blocks['blocks'] = [];
  for (let i = start + 1; i < end; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    const m = CASE_KEY.exec(l);
    if (m) blocks.push({ id: m[1], from: i, to: i + 1 });
    else if (/^ {4}/.test(l) && blocks.length) blocks[blocks.length - 1].to = i + 1;
    else return null; // laid out otherwise: a comment, a flow map, another indentation
  }
  const head = [...lines.slice(0, start), 'cases: {}', ...lines.slice(end)].join('\n');
  return { lines, head, blocks };
}

// Parsed blocks by their text, shared by every run; emptied when it grows large.
const blockCache = new Map<string, RunCase>();

export function readRun(path: string, text: string): TestRun {
  const b = caseBlocks(text);
  if (!b) return readWholeRun(path, text);
  const run = readWholeRun(path, b.head);
  if (run.error) return readWholeRun(path, text);
  if (blockCache.size > 50_000) blockCache.clear();
  const cases: RunCase[] = [];
  for (const { from, to } of b.blocks) {
    const block = b.lines.slice(from, to).join('\n');
    let c = blockCache.get(block);
    if (!c) {
      const one = readWholeRun(path, `cases:\n${block}\n`);
      if (one.error || one.cases.length !== 1) return readWholeRun(path, text);
      blockCache.set(block, (c = one.cases[0]));
    }
    cases.push(c);
  }
  return { ...run, cases };
}

// Changes one case's block with `change` (written for a whole file), or the whole file
// when it isn't laid out in blocks or the case isn't in it.
function inBlock(text: string, id: string, change: (t: string) => string): string {
  const b = caseBlocks(text);
  const at = b?.blocks.find((x) => x.id === id);
  if (!b || !at || b.blocks.filter((x) => x.id === id).length > 1) return change(text);
  const out = change(`cases:\n${b.lines.slice(at.from, at.to).join('\n')}\n`);
  const block = out.replace(/^cases:\n/, '').replace(/\n+$/, '');
  if (!block.startsWith(`  ${id}:`)) return change(text);
  return [...b.lines.slice(0, at.from), block, ...b.lines.slice(at.to)].join('\n');
}

function readWholeRun(path: string, text: string): TestRun {
  const doc = parseDocument(text);
  const run: TestRun = {
    path,
    name: path.replace(/^.*\//, '').replace(/\.ya?ml$/i, ''),
    created: '',
    release: null,
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
    release: str(o.release).trim() || null,
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
        assignee: str(c?.assignee).trim(),
        steps: numbered(c?.steps, (v) => (RESULTS.includes(str(v) as Result) ? (str(v) as Result) : null)),
        stepNotes: numbered(c?.['step-notes'], (v) => str(v) || null),
      };
    }),
  };
}

export interface NewRun {
  name: string;
  created: string;
  release?: string | null;
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
  if (r.release?.trim()) obj.release = r.release.trim();
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
export function setCase(text: string, id: string, changes: Partial<Pick<RunCase, 'result' | 'tester' | 'date' | 'note' | 'assignee'>>): string {
  return inBlock(text, id, (t) => setCaseWhole(t, id, changes));
}

function setCaseWhole(text: string, id: string, changes: Partial<Pick<RunCase, 'result' | 'tester' | 'date' | 'note' | 'assignee'>>): string {
  const doc = parseDocument(text);
  if (!doc.hasIn(['cases', id])) doc.setIn(['cases', id], doc.createNode({ result: 'not-run' }));
  for (const [k, v] of Object.entries(changes)) {
    if (v == null || v === '') doc.deleteIn(['cases', id, k]);
    else doc.setIn(['cases', id, k], v);
  }
  spaceCases(doc);
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false });
}

// One step's result and note (null or empty removes them). Steps and their notes are
// small maps inside the case, so two testers on different steps merge cleanly.
export function setStep(text: string, id: string, step: number, change: { result?: Result | null; note?: string | null }): string {
  return inBlock(text, id, (t) => setStepWhole(t, id, step, change));
}

function setStepWhole(text: string, id: string, step: number, change: { result?: Result | null; note?: string | null }): string {
  const doc = parseDocument(text);
  if (!doc.hasIn(['cases', id])) doc.setIn(['cases', id], doc.createNode({ result: 'not-run' }));
  const put = (field: string, value: unknown) => {
    if (value == null || value === '' || value === 'not-run') doc.deleteIn(['cases', id, field, step]);
    else {
      if (!isMap(doc.getIn(['cases', id, field], true))) doc.setIn(['cases', id, field], doc.createNode({}));
      const m = doc.getIn(['cases', id, field], true) as YAMLMap;
      m.set(doc.createNode(step), value);
      m.items.sort((a, b) => Number((a as Pair<{ value: unknown }>).key.value) - Number((b as Pair<{ value: unknown }>).key.value));
    }
    const m = doc.getIn(['cases', id, field], true);
    if (isMap(m) && !m.items.length) doc.deleteIn(['cases', id, field]);
  };
  if ('result' in change) put('steps', change.result);
  if ('note' in change) put('step-notes', change.note);
  const steps = doc.getIn(['cases', id, 'steps'], true);
  if (isMap(steps)) steps.flow = true;
  spaceCases(doc);
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false });
}

// A case's result from its steps: failed if any step failed, else blocked if any is
// blocked, passed when all `count` passed; not run while steps are left.
export function resultFromSteps(steps: Record<number, Result>, count: number): Result {
  const rs = Object.values(steps);
  if (rs.includes('failed')) return 'failed';
  if (rs.includes('blocked')) return 'blocked';
  let passed = 0;
  for (let n = 1; n <= count; n++) if (steps[n] === 'passed') passed++;
  return count > 0 && passed === count ? 'passed' : 'not-run';
}

// "Step 3 failed: Stops after 2 retries." for the steps that failed or are blocked.
export function stepProblems(c: Pick<RunCase, 'steps' | 'stepNotes'>, stepText: string[] = []): string[] {
  return Object.entries(c.steps)
    .filter(([, r]) => r === 'failed' || r === 'blocked')
    .map(([n, r]) => {
      const text = stepText[Number(n) - 1];
      const note = c.stepNotes[Number(n)];
      return `Step ${n}${text ? ` (${text})` : ''} ${r === 'failed' ? 'failed' : 'blocked'}${note ? `: ${note}` : ''}`;
    });
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

// Sets the release a run is for (empty: none set, so it follows its code tag or fix
// version again). A new field goes after `created`, keeping the rest as written.
export function setRelease(text: string, release: string): string {
  const doc = parseDocument(text);
  const v = release.trim();
  if (!v) doc.delete('release');
  else if (doc.has('release')) doc.set('release', v);
  else if (isMap(doc.contents)) {
    const items = (doc.contents as YAMLMap).items as Pair[];
    const at = items.findIndex((p) => isScalar(p.key) && p.key.value === 'created');
    items.splice(at < 0 ? items.findIndex((p) => isScalar(p.key) && p.key.value === 'name') + 1 : at + 1, 0, doc.createPair('release', v) as Pair);
  }
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false });
}

// The release a run's results count toward: set by hand, or else the code version it
// tested if that's a tag, or else its Jira fix version. A branch (main) moves and a
// commit isn't a version, so neither is a release. Runs from before tags were recorded
// count when it looks like a version: it has a digit and isn't a commit hash.
export function releaseFrom(r: TestRun): { version: string; from: 'set' | 'code' | 'jira' } | null {
  if (r.release) return { version: r.release, from: 'set' };
  const to = r.to?.trim();
  const tag = to && (r.toTag != null ? r.toTag : /\d/.test(to) && !/^[0-9a-f]{7,40}$/i.test(to));
  if (tag) return { version: to, from: 'code' };
  if (r.fixVersion?.trim()) return { version: r.fixVersion.trim(), from: 'jira' };
  return null;
}

export const releaseOf = (r: TestRun): string | null => releaseFrom(r)?.version ?? null;

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

// A run's cases by ID, made once per run (runs are never changed once read).
const byId = new WeakMap<TestRun, Map<string, RunCase>>();
export function caseOf(run: TestRun, id: string): RunCase | undefined {
  let m = byId.get(run);
  if (!m) byId.set(run, (m = new Map(run.cases.map((c) => [c.id, c]))));
  return m.get(id);
}

// Every run a test case is in, as the runs are listed (newest first).
export function resultsFor(runs: TestRun[], id: string): CaseResult[] {
  const out: CaseResult[] = [];
  for (const run of runs) {
    const c = caseOf(run, id);
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
