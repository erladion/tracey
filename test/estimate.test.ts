import { describe, expect, it } from 'vitest';
import { buildIndex } from '../src/core/model';
import { readRun } from '../src/core/runs';
import { durationText, estimateOf, estimateText, formatDuration, parseDuration, runEstimate } from '../src/core/estimate';
import { tables } from '../src/core/spreadsheet';
import { reportMarkdown } from '../src/core/report';

describe('durations', () => {
  it('reads the ways people write a time, in minutes', () => {
    const cases: [unknown, number | null | undefined][] = [
      [30, 30],
      ['45', 45],
      ['30m', 30],
      ['30 min', 30],
      ['1h', 60],
      ['1h 30m', 90],
      ['1h30', 90],
      ['1.5h', 90],
      ['1,5 h', 90],
      ['2 hours', 120],
      ['1:30', 90],
      ['1d', 480],
      ['', undefined],
      [null, undefined],
      ['soon', null],
      ['1h banana', null],
      ['-5', null],
      [-5, null],
    ];
    for (const [v, want] of cases) expect([v, parseDuration(v)]).toEqual([v, want]);
  });
  it('writes them back for people and for the file', () => {
    expect([5, 60, 90, 150].map(formatDuration)).toEqual(['5 min', '1 h', '1 h 30 min', '2 h 30 min']);
    expect([5, 60, 90].map(durationText)).toEqual(['5m', '1h', '1h 30m']);
  });
});

const CONFIG = 'requirements: { dir: requirements }\ntestcases: { dir: tests }\n';
const tc = (id: string, estimate?: string) => ({ path: `tests/${id}.md`, text: `---\nid: ${id}\ntitle: Test ${id}\nstatus: ready\n${estimate ? `estimate: ${estimate}\n` : ''}---\n` });
const index = buildIndex([tc('TC-01', '30m'), tc('TC-02', '1h 15m'), tc('TC-03'), tc('TC-04', 'a while')], CONFIG);

describe('estimates', () => {
  it('reads a test case’s estimate, and warns when it isn’t a time', () => {
    expect(index.items.map((i) => i.estimate)).toEqual([30, 75, null, null]);
    expect(index.problems.filter((p) => p.code === 'bad-estimate').map((p) => p.id)).toEqual(['TC-04']);
  });
  it('adds up a set of test cases, counting those without one', () => {
    const e = estimateOf(['TC-01', 'TC-02', 'TC-03'], index);
    expect(e).toEqual({ minutes: 105, counted: 2, missing: 1 });
    expect(estimateText(e)).toBe('about 1 h 45 min (1 test case has no estimate)');
    expect(estimateText(estimateOf(['TC-03'], index))).toBe('no estimate (no test case has one)');
  });
  it('estimates a run, and what’s left of it', () => {
    const run = readRun('r.yml', 'name: R\ncases:\n  TC-01: { result: passed }\n  TC-02: { result: not-run }\n  TC-03: { result: not-run }\n');
    expect(runEstimate(run, index)).toEqual({ total: { minutes: 105, counted: 2, missing: 1 }, left: { minutes: 75, counted: 1, missing: 1 } });
    expect(reportMarkdown(run, index)).toContain('| Estimated time | about 1 h 45 min (1 test case has no estimate); 1 h 15 min of it not run yet |');
    const t = tables(index, { obsolete: false, component: null, runs: [run] });
    const col = (sheet: 'testcases' | 'runs', h: string) => t[sheet].columns.findIndex((c) => c.header === h);
    expect(t.testcases.rows.map((r) => r[col('testcases', 'Estimate (min)')])).toEqual([30, 75, null, null]);
    expect([t.runs.rows[0][col('runs', 'Estimate (h)')], t.runs.rows[0][col('runs', 'Left (h)')]]).toEqual([1.8, 1.3]);
  });
});
