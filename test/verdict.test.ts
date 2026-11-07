import { describe, expect, it } from 'vitest';
import { buildIndex } from '../src/core/model';
import { readRun } from '../src/core/runs';
import { specHtml } from '../src/core/specdoc';
import { tables } from '../src/core/spreadsheet';
import { csv, xlsx } from '../src/core/xlsx';
import { newRunText, releaseFrom, setRelease } from '../src/core/runs';
import { describeSource, outcome, releaseOf, releases, resultMatrix, sourceName, sourceRuns, verdictOf, verdictSummary, versionKey } from '../src/core/verdict';

const req = (id: string, status = 'approved') => ({ path: `requirements/${id}.md`, text: `---\nid: ${id}\ntitle: Title of ${id}\nstatus: ${status}\n---\nText.\n` });
const tc = (id: string, verifies: string[], status = 'ready') => ({ path: `tests/${id}.md`, text: `---\nid: ${id}\ntitle: Test ${id}\nstatus: ${status}\nverifies: [${verifies.join(', ')}]\n---\n` });
const CONFIG = 'requirements: { dir: requirements }\ntestcases: { dir: tests }\n';

const index = buildIndex(
  [
    req('REQ-01'),
    req('REQ-02'),
    req('REQ-03'),
    req('REQ-04'),
    req('REQ-05'),
    req('REQ-06', 'obsolete'),
    tc('TC-01', ['REQ-01', 'REQ-02']),
    tc('TC-02', ['REQ-02']),
    tc('TC-03', ['REQ-03']),
    tc('TC-04', ['REQ-04']),
    tc('TC-05', ['REQ-04'], 'obsolete'),
  ],
  CONFIG,
);
// Newest first, as runs are listed.
const regression = readRun('test-runs/reg.yml', 'name: Regression 2.4\ncreated: 2026-10-30\ncode: { to: v2.4 }\ncases:\n  TC-01: { result: passed }\n  TC-02: { result: failed, tester: Ana, date: 2026-10-30 }\n  TC-03: { result: not-run }\n');
const smoke = readRun('test-runs/smoke.yml', 'name: Smoke 2.4\ncreated: 2026-10-21\ncode: { to: v2.4 }\ncases:\n  TC-03: { result: blocked }\n  TC-04: { result: passed }\n');
const old = readRun('test-runs/old.yml', 'name: Release 2.3\ncreated: 2026-09-01\njira: { fix-version: "2.3" }\ncases:\n  TC-02: { result: passed }\n  TC-04: { result: failed }\n');
const loose = readRun('test-runs/loose.yml', 'name: Exploratory\ncreated: 2026-11-01\ncases:\n  TC-04: { result: passed }\n');
const runs = [loose, regression, smoke, old];

describe('result sources', () => {
  it('groups runs into releases by code version, or else fix version, newest first', () => {
    expect(releases(runs).map((r) => [r.key, r.name, r.runs.map((x) => x.name)])).toEqual([
      ['2.4', 'v2.4', ['Regression 2.4', 'Smoke 2.4']],
      ['2.3', '2.3', ['Release 2.3']],
    ]);
  });
  it('matches versions without a leading v and ignoring case, code tags with Jira fix versions', () => {
    expect(['v2.4.0', 'V2.4.0', ' 2.4.0 ', 'version-2'].map(versionKey)).toEqual(['2.4.0', '2.4.0', '2.4.0', 'version-2']);
    const a = readRun('a.yml', 'name: A\ncreated: 2026-11-01\ncode: { to: v2.4.0, tag: true }\n');
    const b = readRun('b.yml', 'name: B\ncreated: 2026-11-02\ncode: { to: V2.4.0 }\n');
    const c = readRun('c.yml', 'name: C\ncreated: 2026-11-03\njira: { fix-version: "2.4.0" }\n');
    expect(releases([c, b, a]).map((r) => [r.key, r.name, r.runs.map((x) => x.name)])).toEqual([['2.4.0', 'V2.4.0', ['C', 'B', 'A']]]);
    expect(sourceRuns([c, b, a], { kind: 'release', key: 'v2.4.0' })).toHaveLength(3);
  });
  it('counts only tags as releases, not branches or commits', () => {
    const run = (code: string, jira = '') => readRun('r.yml', `name: R\ncode: ${code}\n${jira}`);
    expect(releaseOf(run('{ to: main, tag: false }'))).toBeNull();
    expect(releaseOf(run('{ to: release/2.4, tag: false }', 'jira: { fix-version: "2.4" }\n'))).toBe('2.4');
    expect(releaseOf(run('{ to: v2.4.0, tag: true }'))).toBe('v2.4.0');
    // Older runs that don't say: a version-like name counts, a branch or commit hash doesn't.
    expect(releaseOf(run('{ to: v2.4.0 }'))).toBe('v2.4.0');
    expect(releaseOf(run('{ to: main }'))).toBeNull();
    expect(releaseOf(run('{ to: 3f2a9c1e }'))).toBeNull();
  });
  it('puts a run in the release set by hand before its tag or fix version', () => {
    const full = readRun('f.yml', 'name: Full regression\ncreated: 2026-11-05\nrelease: 2.4.0\ncases:\n  TC-01: { result: passed }\n');
    const branch = readRun('b.yml', 'name: B\ncreated: 2026-11-04\nrelease: v2.5\ncode: { to: main, tag: false }\njira: { fix-version: "2.4" }\n');
    expect(releaseFrom(full)).toEqual({ version: '2.4.0', from: 'set' });
    expect(releaseFrom(branch)).toEqual({ version: 'v2.5', from: 'set' });
    expect(releaseFrom(readRun('t.yml', 'code: { to: v2.4.0, tag: true }\njira: { fix-version: "9" }\n'))).toEqual({ version: 'v2.4.0', from: 'code' });
    expect(releaseFrom(readRun('j.yml', 'code: { to: main, tag: false }\njira: { fix-version: "2.4" }\n'))).toEqual({ version: '2.4', from: 'jira' });
    // It joins the runs for the tag v2.4.0, named as set by hand.
    const tagged = readRun('t.yml', 'name: T\ncreated: 2026-11-06\ncode: { to: v2.4.0, tag: true }\n');
    expect(releases([tagged, full]).map((r) => [r.key, r.name, r.runs.map((x) => x.name)])).toEqual([['2.4.0', '2.4.0', ['T', 'Full regression']]]);
  });
  it('sets and clears a run’s release, after created and keeping the rest', () => {
    const text = 'name: R\ncreated: 2026-11-07\ncode:\n  to: main\n  tag: false\ncases:\n\n  TC-01:\n    result: passed\n';
    const set = setRelease(text, ' v2.4.0 ');
    expect(set).toBe('name: R\ncreated: 2026-11-07\nrelease: v2.4.0\ncode:\n  to: main\n  tag: false\ncases:\n\n  TC-01:\n    result: passed\n');
    expect(setRelease(set, 'v2.4.1')).toContain('release: v2.4.1\ncode:');
    expect(setRelease(set, '')).toBe(text);
    expect(newRunText({ name: 'R', created: '2026-11-07', release: 'v3', from: null, to: null, codeCommit: null, commitCount: null, requirementsCommit: null, issues: [], gaps: { requirementsWithoutTests: [], componentsWithoutTests: [], issuesWithoutRequirement: [] }, cases: [] })).toMatch(/^name: R\ncreated: 2026-11-07\nrelease: v3\n/);
  });
  it('records whether the code version is a tag', () => {
    const base = { name: 'R', created: '2026-11-07', from: 'v1', codeCommit: 'abc', commitCount: 3, requirementsCommit: null, issues: [], gaps: { requirementsWithoutTests: [], componentsWithoutTests: [], issuesWithoutRequirement: [] }, cases: [] };
    expect(newRunText({ ...base, to: 'v2', toTag: true })).toContain('code:\n  from: v1\n  to: v2\n  tag: true\n  commit: abc');
    expect(readRun('r.yml', newRunText({ ...base, to: 'main', toTag: false })).toTag).toBe(false);
    expect(newRunText({ ...base, to: 'v2' })).not.toContain('tag:');
  });
  it('picks the runs of a source, and none when it no longer exists', () => {
    expect(sourceRuns(runs, { kind: 'latest' })).toHaveLength(4);
    expect(sourceRuns(runs, { kind: 'release', key: 'v2.4' })?.map((r) => r.name)).toEqual(['Regression 2.4', 'Smoke 2.4']);
    expect(sourceRuns(runs, { kind: 'run', path: 'test-runs/old.yml' })?.map((r) => r.name)).toEqual(['Release 2.3']);
    expect(sourceRuns(runs, { kind: 'run', path: 'gone.yml' })).toBeNull();
    expect(sourceRuns(runs, { kind: 'none' })).toBeNull();
    expect(sourceRuns([], { kind: 'latest' })).toBeNull();
  });
  it('names and describes a source', () => {
    expect(sourceName(runs, { kind: 'release', key: 'v2.4' })).toBe('Release v2.4');
    expect(sourceName(runs, { kind: 'run', path: 'test-runs/reg.yml' })).toBe('Test run Regression 2.4');
    expect(describeSource(runs, { kind: 'release', key: 'v2.4' })).toBe(
      'the last result of each test case in the 2 test runs for release v2.4 (Regression 2.4, Smoke 2.4), 2026-10-21 to 2026-10-30',
    );
    expect(describeSource(runs, { kind: 'run', path: 'test-runs/reg.yml' })).toBe('the test run “Regression 2.4”, 2026-10-30');
  });
});

describe('outcomes and verdicts', () => {
  const v24 = sourceRuns(runs, { kind: 'release', key: 'v2.4' })!;
  it('takes the newest result run, and tells not run from not in the runs', () => {
    expect(outcome(v24, 'TC-03').result).toBe('blocked'); // not run in Regression, blocked in Smoke
    expect(outcome(runs, 'TC-04').at?.run.name).toBe('Exploratory');
    expect(outcome([regression], 'TC-03')).toMatchObject({ result: 'not-run', inRuns: true });
    expect(outcome([regression], 'TC-04')).toMatchObject({ result: 'not-run', inRuns: false });
  });
  it('decides a verdict from the results', () => {
    expect(verdictOf([])).toBe('no-tests');
    expect(verdictOf(['passed', 'failed', 'blocked'])).toBe('failing');
    expect(verdictOf(['passed', 'blocked'])).toBe('blocked');
    expect(verdictOf(['passed', 'passed'])).toBe('verified');
    expect(verdictOf(['passed', 'not-run'])).toBe('partial');
    expect(verdictOf(['not-run'])).toBe('not-run');
  });
  it('gives each requirement a verdict; obsolete tests don’t count, obsolete requirements get none', () => {
    const rows = resultMatrix(index, v24);
    expect(rows.map((r) => `${r.req.id}:${r.verdict}`)).toEqual(['REQ-01:verified', 'REQ-02:failing', 'REQ-03:blocked', 'REQ-04:verified', 'REQ-05:no-tests', 'REQ-06:null']);
    expect(rows[3].links.map((l) => l.test.id)).toEqual(['TC-04', 'TC-05']);
    expect(verdictSummary(rows)).toBe('2 of 5 requirements verified · 1 failing · 1 blocked · 1 without tests');
    expect(resultMatrix(index, [regression]).map((r) => r.verdict)).toEqual(['verified', 'failing', 'not-run', 'not-run', 'no-tests', null]);
  });
});

describe('exports with results', () => {
  const results = { runs: sourceRuns(runs, { kind: 'release', key: 'v2.4' })!, name: 'Release v2.4', oneRun: false };
  it('puts verdicts and results in the matrix sheet, coloured by result', () => {
    const t = tables(index, { obsolete: false, component: null, runs, results });
    expect(t.matrix.columns.map((c) => c.header)).toEqual(['Requirement', 'Title', 'Verdict (Release v2.4)', 'TC-01', 'TC-02', 'TC-03', 'TC-04']);
    expect(t.matrix.rows[1]).toEqual(['REQ-02', 'Title of REQ-02', { text: 'Failing', tone: 'bad' }, { text: 'passed', tone: 'good' }, { text: 'failed', tone: 'bad' }, null, null]);
    expect(t.matrix.rows[3].slice(2)).toEqual([{ text: 'Verified', tone: 'good' }, null, null, null, { text: 'passed', tone: 'good' }]);
    expect(csv(t.matrix).split('\r\n')[2]).toBe('REQ-02,Title of REQ-02,Failing,passed,failed,,');
    // Without results, as before: the link's review state.
    expect(tables(index, { obsolete: false, component: null, runs }).matrix.rows[1]).toEqual(['REQ-02', 'Title of REQ-02', 'not reviewed', 'not reviewed', null, null]);
  });
  it('writes the tones as cell styles', () => {
    const t = tables(index, { obsolete: false, component: null, runs, results });
    const file = Buffer.from(xlsx([t.matrix]));
    // The zip is stored uncompressed, so the sheet's XML is in it as is.
    const text = file.toString('utf8');
    expect(text).toContain('<cellXfs count="8">');
    expect(text).toMatch(/<c r="C3" t="inlineStr" s="5"><is><t>Failing<\/t><\/is><\/c>/);
    expect(text).toMatch(/<c r="D3" t="inlineStr" s="4"><is><t>passed<\/t><\/is><\/c>/);
  });
  it('puts verdicts and results in the PDF matrix', () => {
    const html = specHtml(index, {
      title: 'T',
      requirements: false,
      testcases: false,
      matrix: true,
      obsolete: false,
      component: null,
      meta: [],
      image: (_p, s) => s,
      results: { runs: results.runs, description: describeSource(runs, { kind: 'release', key: 'v2.4' }), oneRun: false },
    });
    expect(html).toContain('<th>Verdict</th>');
    expect(html).toContain('2 of 5 requirements verified · 1 failing · 1 blocked · 1 without tests');
    expect(html).toContain('<span class="verdict failing">✕ Failing</span>');
    expect(html).toMatch(/TC-02<\/a> <span class="res failed">✕ failed<\/span>/);
    const plain = specHtml(index, { title: 'T', requirements: false, testcases: false, matrix: true, obsolete: false, component: null, meta: [], image: (_p, s) => s });
    expect(plain).not.toContain('Verdict');
  });
});
