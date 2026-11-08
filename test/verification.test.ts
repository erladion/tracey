import { describe, expect, it } from 'vitest';
import { buildIndex, coverage, type SourceFile } from '../src/core/model';
import { readRun } from '../src/core/runs';
import { combineVerdicts, resultMatrix, verdictSummary, verdictText } from '../src/core/verdict';
import { buildGraph } from '../src/core/graph';
import { tables } from '../src/core/spreadsheet';
import { bulkChanges } from '../src/core/bulk';

const req = (id: string, front = ''): SourceFile => ({ path: `requirements/${id}.md`, text: `---\nid: ${id}\ntitle: ${id} title\nstatus: draft\n${front}---\n${id} text.\n` });
const test = (id: string, verifies: string[]): SourceFile => ({ path: `tests/${id}.md`, text: `---\nid: ${id}\ntitle: ${id} title\nstatus: ready\nverifies: [${verifies.join(', ')}]\n---\n` });
const run = (cases: Record<string, string>) =>
  readRun('test-runs/r.yml', `name: R\ncreated: 2026-11-01\ncases:\n${Object.entries(cases).map(([id, r]) => `  ${id}: { result: ${r} }`).join('\n')}\n`);
const row = (rows: ReturnType<typeof resultMatrix>, id: string) => rows.find((r) => r.req.id === id)!;

describe('verdicts through refinements', () => {
  // REQ-10 is broken down into REQ-1 and REQ-2; REQ-2 into REQ-3.
  const idx = buildIndex([req('REQ-10'), req('REQ-1', 'refines: [REQ-10]\n'), req('REQ-2', 'refines: [REQ-10]\n'), req('REQ-3', 'refines: [REQ-2]\n'), test('TC-1', ['REQ-1']), test('TC-3', ['REQ-3'])], null);

  it('takes the worst verdict of the requirements refining it, and says which', () => {
    const rows = resultMatrix(idx, [run({ 'TC-1': 'passed', 'TC-3': 'failed' })]);
    expect(row(rows, 'REQ-3')).toMatchObject({ verdict: 'failing', via: 'tests' });
    expect(row(rows, 'REQ-2')).toMatchObject({ verdict: 'failing', via: 'refinements' });
    expect(verdictText(row(rows, 'REQ-10'))).toBe('Failing (via REQ-2)');
    expect(verdictSummary(rows)).toBe('1 of 4 requirements verified · 3 failing');
  });

  it('is verified when all of them are, and partly when some are', () => {
    expect(verdictText(row(resultMatrix(idx, [run({ 'TC-1': 'passed', 'TC-3': 'passed' })]), 'REQ-10'))).toBe('Verified (via REQ-1, REQ-2)');
    expect(verdictText(row(resultMatrix(idx, [run({ 'TC-1': 'passed' })]), 'REQ-10'))).toBe('Partly run (via REQ-2)');
  });

  it('agrees with coverage: one refinement without tests leaves it without', () => {
    const less = buildIndex([req('REQ-10'), req('REQ-1', 'refines: [REQ-10]\n'), req('REQ-2', 'refines: [REQ-10]\n'), test('TC-1', ['REQ-1'])], null);
    const rows = resultMatrix(less, [run({ 'TC-1': 'failed' })]);
    expect(verdictText(row(rows, 'REQ-10'))).toBe('No tests (via REQ-2)');
    expect(coverage(less).untested.map((r) => r.id).sort()).toEqual(['REQ-10', 'REQ-2']);
  });

  it('combines worst first', () => {
    expect(combineVerdicts(['verified', 'blocked', 'failing'])).toBe('failing');
    expect(combineVerdicts(['verified', 'not-run'])).toBe('partial');
    expect(combineVerdicts(['not-run', 'not-run'])).toBe('not-run');
  });

  it("doesn't hang on a loop", () => {
    const loop = buildIndex([req('REQ-1', 'refines: [REQ-2]\n'), req('REQ-2', 'refines: [REQ-1]\n')], null);
    expect(resultMatrix(loop, []).map((r) => r.verdict)).toEqual(['no-tests', 'no-tests']);
  });
});

describe('verification method', () => {
  const files = [
    req('REQ-1', 'verification: analysis\nevidence: [docs/timing-analysis.pdf]\n'),
    req('REQ-2', 'verification: inspection\n'),
    req('REQ-3', 'verification: none\n'),
    req('REQ-4'),
    req('REQ-5', 'verification: none\n'),
    test('TC-4', ['REQ-4']),
    test('TC-5', ['REQ-5']),
  ];
  const idx = buildIndex(files, null);

  it('covers by evidence, and leaves out what needs no verification', () => {
    const cov = coverage(idx);
    expect(cov.tested.map((r) => r.id)).toEqual(['REQ-1', 'REQ-4', 'REQ-5']);
    expect(cov.byEvidence.map((r) => r.id)).toEqual(['REQ-1']);
    expect(cov.untested.map((r) => r.id)).toEqual(['REQ-2']);
    expect(cov.exempt.map((r) => r.id)).toEqual(['REQ-3']);
    expect(cov.counted.length).toBe(4); // REQ-3 isn't counted
  });

  it('gives verdicts and gaps to match', () => {
    const rows = resultMatrix(idx, [run({ 'TC-4': 'passed', 'TC-5': 'failed' })]);
    expect(rows.map(verdictText)).toEqual(['Verified (analysis)', 'No evidence', 'None needed', 'Verified', 'Failing']);
    expect(verdictSummary(rows)).toBe('2 of 4 requirements verified · 1 failing · 1 not covered');
    const g = buildGraph(idx);
    expect(g.byKey.get('req:REQ-2')!.tag).toBe('No evidence');
    expect(g.byKey.get('req:REQ-3')!.gap).toBeUndefined();
  });

  it("doesn't let a refinement needing no verification hold its parent back", () => {
    const i = buildIndex([req('REQ-10'), req('REQ-1', 'refines: [REQ-10]\n'), req('REQ-2', 'refines: [REQ-10]\nverification: none\n'), test('TC-1', ['REQ-1'])], null);
    expect(coverage(i).throughRefinements.map((r) => r.id)).toEqual(['REQ-10']);
    expect(verdictText(row(resultMatrix(i, [run({ 'TC-1': 'passed' })]), 'REQ-10'))).toBe('Verified (via REQ-1)');
  });

  it('reports a method it doesn’t know, and takes it as test', () => {
    const i = buildIndex([req('REQ-1', 'verification: guesswork\n')], null);
    expect(i.byId.get('REQ-1')!.verification).toBe('test');
    expect(i.problems.map((p) => p.code)).toEqual(['bad-verification']);
  });

  it('exports the method and evidence, and changes them in bulk', () => {
    const sheet = tables(idx, { obsolete: false, component: null, runs: [] }).requirements;
    const col = (h: string) => sheet.columns.findIndex((c) => c.header === h);
    expect(sheet.rows.map((r) => [r[0], r[col('Verification')], r[col('Evidence')], r[col('Covered')]])).toEqual([
      ['REQ-1', 'Analysis', 'docs/timing-analysis.pdf', 'By evidence'],
      ['REQ-2', 'Inspection', '', 'No'],
      ['REQ-3', 'None needed', '', 'Not needed'],
      ['REQ-4', 'Test', '', 'Yes'],
      ['REQ-5', 'None needed', '', 'Yes'],
    ]);
    const items = ['REQ-1', 'REQ-4', 'TC-4'].map((id) => idx.byId.get(id)!);
    const c = bulkChanges(items, { set: { verification: 'test' }, add: { evidence: ['memo.pdf'] }, remove: {} }, idx);
    expect(c.get('requirements/REQ-1.md')).toEqual({ verification: undefined, evidence: ['docs/timing-analysis.pdf', 'memo.pdf'] });
    expect(c.get('requirements/REQ-4.md')).toEqual({ evidence: ['memo.pdf'] });
    expect(c.has('tests/TC-4.md')).toBe(false);
  });
});
