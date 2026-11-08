import { describe, expect, it } from 'vitest';
import { stepsOf } from '../src/core/steps';
import { readRun, resultFromSteps, setCase, setStep, stepProblems } from '../src/core/runs';
import { mergeRun } from '../src/core/merge';
import { buildIndex } from '../src/core/model';
import { reportHtml, reportMarkdown } from '../src/core/report';

const BODY = '## Steps\n\n1. Configure the gateway\n   to time out once.\n2. Submit a **payment**.\n   - with a saved card\n3. Check the logs.\n\n## Expected\n\nOne charge.\n';
const RUN = 'name: R\ncreated: 2026-11-08\ncases:\n\n  TC-1:\n    result: not-run\n\n  TC-2:\n    result: not-run\n';

describe('test steps', () => {
  it('reads the numbered list under Steps, and the rest of the text', () => {
    expect(stepsOf(BODY)).toEqual({ steps: ['Configure the gateway to time out once.', 'Submit a **payment**.', 'Check the logs.'], rest: '## Expected\n\nOne charge.' });
    expect(stepsOf('### Test steps\n1. One\n2. Two\n').steps).toEqual(['One', 'Two']);
    expect(stepsOf('Just text.\n\n1. Not under Steps\n').steps).toEqual([]);
    expect(stepsOf('## Steps\n\n- a bullet, not numbered\n').steps).toEqual([]);
  });

  it('records a result and note per step, as small maps in the case', () => {
    let t = setStep(RUN, 'TC-1', 2, { result: 'failed', note: 'Charged twice.' });
    t = setStep(t, 'TC-1', 1, { result: 'passed' });
    expect(t).toContain('  TC-1:\n    result: not-run\n    steps: {1: passed, 2: failed}\n    step-notes:\n      2: Charged twice.\n');
    const c = readRun('test-runs/r.yml', t).cases[0];
    expect([c.steps, c.stepNotes]).toEqual([{ 1: 'passed', 2: 'failed' }, { 2: 'Charged twice.' }]);
    expect(stepProblems(c, stepsOf(BODY).steps)).toEqual(['Step 2 (Submit a **payment**.) failed: Charged twice.']);
    // Clearing a step removes it, and the maps go when empty.
    t = setStep(setStep(t, 'TC-1', 2, { result: null, note: null }), 'TC-1', 1, { result: null });
    expect(t).not.toContain('steps');
  });

  it('gives the case the result its steps add up to', () => {
    expect(resultFromSteps({ 1: 'passed', 2: 'failed' }, 3)).toBe('failed');
    expect(resultFromSteps({ 1: 'blocked', 2: 'passed' }, 3)).toBe('blocked');
    expect(resultFromSteps({ 1: 'passed', 2: 'passed' }, 3)).toBe('not-run');
    expect(resultFromSteps({ 1: 'passed', 2: 'passed', 3: 'passed' }, 3)).toBe('passed');
  });

  it('keeps assignees and notes over several lines', () => {
    const t = setCase(setCase(RUN, 'TC-2', { assignee: 'Bo' }), 'TC-1', { note: 'First line.\nSecond line.' });
    const run = readRun('test-runs/r.yml', t);
    expect(run.cases.map((c) => [c.id, c.assignee, c.note])).toEqual([
      ['TC-1', '', 'First line.\nSecond line.'],
      ['TC-2', 'Bo', ''],
    ]);
    expect(readRun('test-runs/r.yml', setCase(t, 'TC-2', { assignee: '' })).cases[1].assignee).toBe('');
  });

  it('merges two testers recording different steps of one case', () => {
    const ana = setStep(RUN, 'TC-1', 1, { result: 'passed' });
    const bo = setStep(setCase(RUN, 'TC-1', { assignee: 'Bo' }), 'TC-1', 3, { result: 'failed' });
    const plan = mergeRun(RUN, ana, bo);
    expect(plan.conflicts).toEqual([]);
    const merged = readRun('test-runs/r.yml', plan.build([])!).cases[0];
    expect([merged.steps, merged.assignee]).toEqual([{ 1: 'passed', 3: 'failed' }, 'Bo']);
  });

  it('shows failed steps and assignees in the report', () => {
    const index = buildIndex([{ path: 'tests/TC-1.md', text: `---\nid: TC-1\ntitle: Retry\nstatus: ready\nverifies: []\n---\n${BODY}` }], null);
    let t = setStep(RUN, 'TC-1', 2, { result: 'failed', note: 'Charged twice.' });
    t = setCase(t, 'TC-1', { result: 'failed', tester: 'Ana', date: '2026-11-08', assignee: 'Ana', note: 'PROJ-9 filed.\nSee logs.' });
    const run = readRun('test-runs/r.yml', t);
    const mdText = reportMarkdown(run, index);
    expect(mdText).toContain('- **TC-1** Retry: Failed (Ana, 2026-11-08). PROJ-9 filed.; See logs.\n  - Step 2 (Submit a **payment**.) failed: Charged twice.');
    expect(mdText).toContain('| Ana | Step 2 (Submit a **payment**.) failed: Charged twice.; PROJ-9 filed.\nSee logs.'.replace('\n', ' '));
    expect(reportHtml(run, index)).toContain('<span class="step-problem">Step 2 (Submit a **payment**.) failed: Charged twice.</span><br>PROJ-9 filed.<br>See logs.');
  });
});
