import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIndex } from '../src/core/model';
import { projectFiles } from '../src/core/sample';
import { linkCommits } from '../src/core/commits';
import { impact, reasonText } from '../src/core/impact';
import { addCases, lastResult, newRunText, readRun, removeCase, resultsFor, setCase, summarize } from '../src/core/runs';
import { reportHtml, reportMarkdown } from '../src/core/report';

const files = Object.entries(projectFiles(true))
  .filter(([p]) => p.endsWith('.md') && p !== 'README.md')
  .map(([path, text]) => ({ path, text }));
const index = buildIndex(files, projectFiles(true)['trace.yml']);
const commit = (hash: string, subject: string, files: string[] = []) => ({ hash, author: 'A', date: '2026-11-01T10:00:00Z', subject, body: '', files });

describe('impact', () => {
  const linked = linkCommits(
    [
      commit('aaaa1111', 'PROJ-466: back-off', ['src/payments/retry.ts']),
      commit('bbbb2222', 'PROJ-466 cap at 3', ['src/payments/retry.ts', 'docs/x.md']),
      commit('cccc3333', 'PROJ-999 export button', ['src/export/pdf.ts']),
      commit('dddd4444', 'Tidy', ['README.md']),
    ],
    index,
  );

  it('picks test cases through issues and components, with reasons', () => {
    const im = impact(index, linked);
    expect([...im.cases.keys()].sort()).toEqual(['TC-101', 'TC-102']);
    expect(im.cases.get('TC-101')!.map((r) => reasonText(r))).toEqual(['PROJ-466 → REQ-07 (2 commits)', 'payments changed (2 commits)']);
    expect(im.issuesWithoutRequirement).toEqual(['PROJ-999']);
    expect(im.componentsWithoutTests).toEqual(['export']);
    expect(im.requirements.has('REQ-19')).toBe(true); // tagged with the export component
    expect(im.requirementsWithoutTests).toEqual(['REQ-19']);
    expect(im.commitsWithoutKeys).toBe(1);
  });

  it('can leave components out', () => {
    expect([...impact(index, linked, { components: false }).cases.get('TC-101')!].length).toBe(1);
  });
});

describe('test runs', () => {
  const text = newRunText({
    name: 'Release 2.4.0',
    created: '2026-11-06',
    from: 'v2.3.0',
    to: 'v2.4.0',
    codeCommit: 'abc123',
    commitCount: 4,
    requirementsCommit: 'def456',
    issues: ['PROJ-466'],
    gaps: { requirementsWithoutTests: ['REQ-19'], componentsWithoutTests: [], issuesWithoutRequirement: ['PROJ-999'] },
    cases: [
      { id: 'TC-101', reason: ['PROJ-466 → REQ-07 (2 commits)'] },
      { id: 'TC-102', reason: ['PROJ-466 → REQ-07 (2 commits)'] },
    ],
  });

  it('writes and reads a run', () => {
    expect(text).toContain('cases:\n  TC-101:\n    result: not-run\n    reason: [PROJ-466 → REQ-07 (2 commits)]\n\n  TC-102:');
    const run = readRun('test-runs/release-2-4-0.yml', text);
    expect(run).toMatchObject({ name: 'Release 2.4.0', from: 'v2.3.0', to: 'v2.4.0', codeCommit: 'abc123', commitCount: 4 });
    expect(run.cases.map((c) => c.id)).toEqual(['TC-101', 'TC-102']);
  });

  it('records results, adds and removes cases', () => {
    let t = setCase(text, 'TC-101', { result: 'failed', tester: 'Ana', date: '2026-11-07', note: 'Fails on 3rd: no message' });
    t = addCases(t, [{ id: 'TC-140', reason: [] }]);
    t = removeCase(t, 'TC-102');
    const run = readRun('x.yml', t);
    expect(run.cases.map((c) => [c.id, c.result])).toEqual([
      ['TC-101', 'failed'],
      ['TC-140', 'not-run'],
    ]);
    expect(summarize(run)).toMatchObject({ total: 2, failed: 1, notRun: 1, done: 1 });
  });

  it('merges two testers’ results in git without conflicts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-run-'));
    const sh = (c: string) => execSync(c, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' } }).toString();
    sh('git init -q -b main');
    writeFileSync(join(dir, 'run.yml'), text);
    sh('git add -A && git commit -qm run && git branch other');
    writeFileSync(join(dir, 'run.yml'), setCase(text, 'TC-101', { result: 'passed', tester: 'Ana', date: '2026-11-07' }));
    sh('git commit -qam ana && git checkout -q other');
    writeFileSync(join(dir, 'run.yml'), setCase(text, 'TC-102', { result: 'failed', tester: 'Bo', date: '2026-11-07', note: 'Broken' }));
    sh('git commit -qam bo && git checkout -q main && git merge -q --no-edit other');
    const run = readRun('run.yml', readFileSync(join(dir, 'run.yml'), 'utf8'));
    expect(run.cases.map((c) => c.result)).toEqual(['passed', 'failed']);
  });

  it('reports', () => {
    const run = readRun('x.yml', setCase(text, 'TC-101', { result: 'failed', tester: 'Ana', date: '2026-11-07', note: 'a | b' }));
    const md = reportMarkdown(run, index, new Date('2026-11-08T10:00:00Z'));
    expect(md).toContain('2 test cases: **0 passed**, **1 failed**, 0 blocked, 1 not run');
    expect(md).toContain('| REQ-07 Payment retry after gateway timeout | Failed | TC-101: Failed, TC-102: Not run |');
    expect(md).toContain('a \\| b');
    const html = reportHtml(run, index);
    expect(html).toContain('<h1>Test report: Release 2.4.0</h1>');
    expect(html).not.toContain('<script');
  });
});

describe('a test case’s results', () => {
  const run = (path: string, created: string, cases: string) => readRun(path, `name: ${path}\ncreated: ${created}\ncases:\n${cases}`);
  const runs = [
    run('new.yml', '2026-11-06', '  TC-1: { result: not-run }\n  TC-2: { result: passed, tester: Ana, date: 2026-11-06 }\n'),
    run('old.yml', '2026-10-01', '  TC-1: { result: failed, tester: Erik, date: 2026-10-02 }\n'),
    run('older.yml', '2026-09-01', '  TC-1: { result: passed }\n'),
  ];
  it('lists every run it is in, newest first', () => {
    expect(resultsFor(runs, 'TC-1').map((r) => `${r.run.path}:${r.case.result}`)).toEqual(['new.yml:not-run', 'old.yml:failed', 'older.yml:passed']);
    expect(resultsFor(runs, 'TC-9')).toEqual([]);
  });
  it('knows the last time it was run, skipping runs where it is still to do', () => {
    expect(lastResult(runs, 'TC-1')).toMatchObject({ run: { path: 'old.yml' }, case: { result: 'failed', tester: 'Erik' } });
    expect(lastResult(runs, 'TC-2')?.case.result).toBe('passed');
    expect(lastResult(runs, 'TC-9')).toBeNull();
  });
});
