import { describe, expect, it } from 'vitest';
import { buildIndex, coverage, fingerprint, type SourceFile } from '../src/core/model';
import { idPattern, movedPath, planRename } from '../src/core/rename';

const fp = (title: string, body: string) => fingerprint({ title, body });

const files: SourceFile[] = [
  { path: 'requirements/REQ-7-retry.md', text: `---\nid: REQ-7\ntitle: Retry payments\nstatus: draft\n---\nRetry, unlike REQ-70.\n` },
  { path: 'requirements/REQ-70.md', text: `---\nid: REQ-70\ntitle: Seventy\nstatus: draft\n---\nSee REQ-7 and [the file](REQ-7-retry.md).\n` },
  { path: 'requirements/REQ-8.md', text: `---\nid: REQ-8\ntitle: Eight\nstatus: draft\nrefines: [REQ-7]\nreviewed:\n  REQ-7: "${fp('Retry payments', 'Retry, unlike REQ-70.\n')}"\n---\n![shot](images/REQ-7.png)\n` },
  {
    path: 'tests/TC-1.md',
    text: `---\nid: TC-1\ntitle: One\nstatus: ready\nverifies: [REQ-7, REQ-70]\nreviewed:\n  REQ-7: "${fp('Retry payments', 'Retry, unlike REQ-70.\n')}"\n  REQ-70: "${fp('Seventy', 'See REQ-7 and [the file](REQ-7-retry.md).\n')}"\n---\n`,
  },
  { path: 'test-runs/r.yml', text: 'name: R\ncases:\n\n  TC-1:\n    result: passed\n    reason: [PROJ-1 → REQ-7 (1 commit)]\n' },
];
const texts = new Map(files.map((f) => [f.path, f.text]));
const index = buildIndex(files, null);

describe('renaming an ID', () => {
  it('matches the ID as a whole word only', () => {
    expect('REQ-7, REQ-70, REQ-7.1, images/REQ-7.png, (REQ-7). REQ-7: x-REQ-7'.replace(idPattern('REQ-7'), 'X')).toBe('X, REQ-70, REQ-7.1, images/REQ-7.png, (X). X: x-REQ-7');
  });

  it('changes everything naming it, and keeps reviewed links reviewed', () => {
    const plan = planRename(index, texts, null, index.byId.get('REQ-7')!, 'REQ-007', true);
    expect(plan.move).toEqual({ from: 'requirements/REQ-7-retry.md', to: 'requirements/REQ-007-retry.md' });
    expect(plan.items.map((i) => i.id)).toEqual(['REQ-8', 'REQ-70', 'TC-1']);
    expect(plan.runs).toEqual(['test-runs/r.yml']);
    const after = new Map([...texts, ...plan.texts]);
    after.set(plan.move!.to, after.get(plan.move!.from)!);
    after.delete(plan.move!.from);
    expect(after.get('requirements/REQ-70.md')).toContain('See REQ-007 and [the file](REQ-007-retry.md).');
    expect(after.get('requirements/REQ-8.md')).toContain('refines: [REQ-007]');
    expect(after.get('requirements/REQ-8.md')).toContain('images/REQ-7.png'); // the image keeps its name
    expect(after.get('test-runs/r.yml')).toContain('PROJ-1 → REQ-007');
    const idx = buildIndex([...after].map(([path, text]) => ({ path, text })), null);
    expect(idx.problems).toEqual([]);
    expect(idx.byId.get('REQ-007')!.path).toBe('requirements/REQ-007-retry.md');
    // REQ-70's text changed (it mentions REQ-7), but TC-1's review of it still holds.
    const cov = coverage(idx);
    expect(cov.suspect).toEqual([]);
    expect(cov.suspectRefines).toEqual([]);
    expect(cov.unreviewed).toEqual([]);
  });

  it('keeps a link that was already suspect suspect', () => {
    const stale = texts.get('tests/TC-1.md')!.replace(/REQ-70: "\w+"/, 'REQ-70: "00000000"');
    const t = new Map(texts).set('tests/TC-1.md', stale);
    const idx = buildIndex([...t].map(([path, text]) => ({ path, text })), null);
    const plan = planRename(idx, t, null, idx.byId.get('REQ-7')!, 'REQ-007', false);
    expect(plan.move).toBeNull();
    expect(plan.texts.get('tests/TC-1.md')).toContain('REQ-70: "00000000"');
  });

  it('only renames the one file when the ID is a duplicate', () => {
    const dup = [...files, { path: 'requirements/other.md', text: '---\nid: REQ-7\ntitle: Other\nstatus: draft\n---\n' }];
    const idx = buildIndex(dup, null);
    const plan = planRename(idx, new Map(dup.map((f) => [f.path, f.text])), null, idx.byPath.get('requirements/other.md')!, 'REQ-9', true);
    expect(plan.duplicate).toBe(true);
    expect([...plan.texts.keys()]).toEqual(['requirements/other.md']);
    expect(plan.texts.get('requirements/other.md')).toContain('id: REQ-9');
    expect(plan.move).toBeNull(); // not named after the ID
  });

  it('moves a file only when it is named after the ID', () => {
    const taken = (p: string) => p === 'r/REQ-8-a.md';
    expect(movedPath('r/REQ-7.md', 'REQ-7', 'REQ-8', taken)).toBe('r/REQ-8.md');
    expect(movedPath('r/REQ-7-a.md', 'REQ-7', 'REQ-8', taken)).toBe('r/REQ-8-a-2.md');
    expect(movedPath('r/REQ-70.md', 'REQ-7', 'REQ-8', taken)).toBeNull();
    expect(movedPath('r/retry.md', 'REQ-7', 'REQ-8', taken)).toBeNull();
  });
});
