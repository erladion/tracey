import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { merge3, mergeItem, mergeRun, planMerge } from '../src/core/merge';
import { readRun } from '../src/core/runs';
import { git } from '../src/backend/git';

const item = (fields: string, body: string) => `---\nid: REQ-07\n${fields}---\n${body}`;
const BASE = item('title: Retry\nstatus: draft\nverifies: []\ncomponents: [payments]\n', 'Intro paragraph.\n\nThe client retries 3 times.\n\nClosing words.\n');

describe('merging values', () => {
  it('takes the side that changed, and merges name lists as sets', () => {
    expect(merge3('a', 'a', 'b')).toMatchObject({ value: 'b', conflict: false });
    expect(merge3('a', 'c', 'a')).toMatchObject({ value: 'c', conflict: false });
    expect(merge3('a', 'b', 'c')).toMatchObject({ conflict: true });
    expect(merge3(['x', 'y'], ['x', 'y', 'mine'], ['y', 'theirs'])).toMatchObject({ value: ['y', 'mine', 'theirs'], conflict: false });
  });
});

describe('merging a requirement', () => {
  it('merges different fields and different paragraphs without asking', () => {
    const ours = item('title: Retry\nstatus: approved\nverifies: []\ncomponents: [payments, audit]\n', 'Intro paragraph, edited by me.\n\nThe client retries 3 times.\n\nClosing words.\n');
    const theirs = item('title: Retry on timeout\nstatus: draft\nverifies: []\ncomponents: [payments, export]\n', 'Intro paragraph.\n\nThe client retries 3 times.\n\nClosing words, edited on the server.\n');
    const plan = mergeItem(BASE, ours, theirs);
    expect(plan.conflicts).toEqual([]);
    expect(plan.auto).toEqual(['Title', 'Components', '1 text change']);
    const out = plan.build([]);
    expect(out).toContain('title: Retry on timeout');
    expect(out).toContain('status: approved');
    expect(out).toContain('components: [payments, audit, export]');
    expect(out).toContain('Intro paragraph, edited by me.');
    expect(out).toContain('Closing words, edited on the server.');
  });

  it('asks when both changed the same field or paragraph, and builds what was chosen', () => {
    const ours = item('title: Retry\nstatus: approved\nverifies: []\ncomponents: [payments]\n', 'Intro paragraph.\n\nThe client retries 5 times.\n\nClosing words.\n');
    const theirs = item('title: Retry\nstatus: rejected\nverifies: []\ncomponents: [payments]\n', 'Intro paragraph.\n\nThe client retries 4 times.\n\nClosing words.\n');
    const plan = mergeItem(BASE, ours, theirs);
    expect(plan.conflicts.map((c) => c.kind)).toEqual(['field', 'text']);
    expect(plan.conflicts[0]).toMatchObject({ label: 'Status', base: 'draft', ours: 'approved', theirs: 'rejected' });
    expect(plan.conflicts[1]).toMatchObject({ ours: ['The client retries 5 times.'], theirs: ['The client retries 4 times.'] });
    const theirsOut = plan.build(['theirs', 'theirs'])!;
    expect(theirsOut).toContain('status: rejected');
    expect(theirsOut).toContain('retries 4 times');
    expect(theirsOut).not.toContain('retries 5 times');
    const both = plan.build(['ours', 'both'])!;
    expect(both).toContain('status: approved');
    expect(both.indexOf('retries 5')).toBeLessThan(both.indexOf('retries 4'));
  });

  it('keeps your file as it was written when nothing comes from the server', () => {
    const ours = item('title:   Retry   # spacing kept\nstatus: draft\nverifies: []\ncomponents: [payments]\n', 'Intro   paragraph.\n\nThe client retries 3 times.\n\nClosing words.\n');
    expect(mergeItem(BASE, ours, BASE).build([])).toBe(ours);
  });
});

describe('merging a test run', () => {
  const run = (cases: string) => `name: Release 2.4.0\ncases:\n${cases}`;
  const base = run('\n  TC-1:\n    result: not-run\n\n  TC-2:\n    result: not-run\n');
  it('takes each tester’s cases, and asks about a case both recorded', () => {
    const ours = run('\n  TC-1:\n    result: passed\n    tester: Ana\n\n  TC-2:\n    result: failed\n    tester: Ana\n');
    const theirs = run('\n  TC-1:\n    result: not-run\n\n  TC-2:\n    result: passed\n    tester: Erik\n\n  TC-3:\n    result: not-run\n');
    const plan = mergeRun(base, ours, theirs);
    expect(plan.auto).toEqual(['1 test case']);
    expect(plan.conflicts).toEqual([{ kind: 'case', id: 'TC-2', base: 'not-run', ours: 'failed (Ana)', theirs: 'passed (Erik)' }]);
    const merged = readRun('r.yml', plan.build(['theirs'])!);
    expect(merged.cases.map((c) => `${c.id}:${c.result}:${c.tester}`)).toEqual(['TC-1:passed:Ana', 'TC-2:passed:Erik', 'TC-3:not-run:']);
  });

  it('other files: yours or theirs, whole', () => {
    const plan = planMerge('trace.yml', 'test-runs', 'a', 'b', 'c');
    expect(plan.kind).toBe('file');
    expect(plan.build(['theirs'])).toBe('c');
  });
});

describe('getting the latest with conflicts', () => {
  it('stops on a merge, resolves in Trace, and finishes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'trace-merge-'));
    const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' };
    const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, stdio: 'pipe' }).toString();
    const server = join(root, 'server.git');
    g(root, 'init', '-q', '--bare', '-b', 'main', server);
    const ana = join(root, 'ana');
    g(root, 'clone', '-q', server, ana);
    mkdirSync(join(ana, 'requirements'));
    writeFileSync(join(ana, 'requirements', 'REQ-07.md'), BASE);
    g(ana, 'add', '.');
    g(ana, 'commit', '-qm', 'First');
    g(ana, 'push', '-q', 'origin', 'HEAD:main');
    const erik = join(root, 'erik');
    g(root, 'clone', '-q', server, erik);
    // Erik changes the status and the paragraph; Ana changes the same ones differently.
    writeFileSync(join(erik, 'requirements', 'REQ-07.md'), BASE.replace('draft', 'rejected').replace('3 times', '4 times'));
    g(erik, 'commit', '-qam', 'Erik');
    g(erik, 'push', '-q');
    writeFileSync(join(ana, 'requirements', 'REQ-07.md'), BASE.replace('draft', 'approved').replace('3 times', '5 times').replace('Closing words.', 'Closing words, Ana.'));
    g(ana, 'commit', '-qam', 'Ana');
    g(ana, 'branch', '-q', '--set-upstream-to=origin/main');

    expect(await git.pull(ana, { name: 'Ana', email: 'ana@x' })).toBe('conflicts');
    const s = await git.status(ana);
    expect(s!.merging).toBe(true);
    expect(s!.changes).toEqual([{ path: 'requirements/REQ-07.md', kind: 'conflicted' }]);
    const v = await git.conflict(ana, 'requirements/REQ-07.md');
    const plan = planMerge('requirements/REQ-07.md', 'test-runs', v.base, v.ours, v.theirs);
    expect(plan.conflicts.length).toBe(2);
    writeFileSync(join(ana, 'requirements', 'REQ-07.md'), plan.build(['ours', 'theirs'])!);
    await git.markResolved(ana, 'requirements/REQ-07.md');
    await git.finishMerge(ana, { name: 'Ana', email: 'ana@x' });
    expect((await git.status(ana))!.merging).toBe(false);
    const text = readFileSync(join(ana, 'requirements', 'REQ-07.md'), 'utf8');
    expect(text).toContain('status: approved');
    expect(text).toContain('retries 4 times');
    expect(text).toContain('Closing words, Ana.');
    expect(g(ana, 'log', '-1', '--format=%an %P').split(' ').length).toBe(3); // a merge commit, by Ana
  });
});
