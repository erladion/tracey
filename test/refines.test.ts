import { describe, expect, it } from 'vitest';
import { buildIndex, coverage, fingerprint, forVariant, newItemText, refinesOf, type SourceFile } from '../src/core/model';
import { buildGraph, columns } from '../src/core/graph';
import { bulkChanges } from '../src/core/bulk';
import { tables } from '../src/core/spreadsheet';

const req = (id: string, front: string, body = `${id} text.`): SourceFile => ({ path: `requirements/${id}.md`, text: `---\nid: ${id}\ntitle: ${id} title\nstatus: draft\n${front}---\n${body}\n` });
const test = (id: string, verifies: string[]): SourceFile => ({ path: `tests/${id}.md`, text: `---\nid: ${id}\ntitle: ${id} title\nstatus: ready\nverifies: [${verifies.join(', ')}]\n---\n` });
const fp = (id: string) => fingerprint({ title: `${id} title`, body: `${id} text.` });

// STK-1 is broken down into REQ-1 and REQ-2; REQ-2 into REQ-3. Tests verify REQ-1 and REQ-3.
const files = (extra: SourceFile[] = []) => [
  req('REQ-10', ''),
  req('REQ-1', `refines: [REQ-10]\nreviewed:\n  REQ-10: "${fp('REQ-10')}"\n`),
  req('REQ-2', `refines: [REQ-10]\nreviewed:\n  REQ-10: "${fp('REQ-10')}"\n`),
  req('REQ-3', `refines: [REQ-2]\nreviewed:\n  REQ-2: "${fp('REQ-2')}"\n`),
  test('TC-1', ['REQ-1']),
  test('TC-3', ['REQ-3']),
  ...extra,
];

describe('refines', () => {
  it('links a requirement to the ones it breaks down, both ways', () => {
    const idx = buildIndex(files(), null);
    expect(idx.byId.get('REQ-3')!.refines).toEqual(['REQ-2']);
    expect(idx.refinedBy.get('REQ-10')!.map((r) => r.id)).toEqual(['REQ-1', 'REQ-2']);
    const { up, down } = refinesOf(idx, idx.byId.get('REQ-2')!);
    expect(up.map((l) => [l.parent.id, l.state])).toEqual([['REQ-10', 'ok']]);
    expect(down.map((l) => [l.child.id, l.state])).toEqual([['REQ-3', 'ok']]);
    expect(idx.problems).toEqual([]);
  });

  it('counts a requirement covered when everything refining it is', () => {
    let cov = coverage(buildIndex(files(), null));
    expect(cov.tested.map((r) => r.id).sort()).toEqual(['REQ-1', 'REQ-10', 'REQ-2', 'REQ-3']);
    expect(cov.throughRefinements.map((r) => r.id).sort()).toEqual(['REQ-10', 'REQ-2']);
    expect(cov.untested).toEqual([]);
    // TC-3 gone: REQ-3 has no test, so neither REQ-2 nor REQ-10 is covered.
    cov = coverage(buildIndex(files().filter((f) => !f.path.includes('TC-3')), null));
    expect(cov.untested.map((r) => r.id).sort()).toEqual(['REQ-10', 'REQ-2', 'REQ-3']);
  });

  it('makes a link suspect when the requirement it refines changes', () => {
    const changed = files().map((f) => (f.path.endsWith('REQ-10.md') ? { ...f, text: f.text.replace('REQ-10 text.', 'Something else now.') } : f));
    const idx = buildIndex(changed, null);
    expect(coverage(idx).suspectRefines.map((l) => `${l.child.id}→${l.parent.id}`)).toEqual(['REQ-1→REQ-10', 'REQ-2→REQ-10']);
    const g = buildGraph(idx);
    expect(g.byKey.get('req:REQ-1')!.tag).toBe('Suspect');
  });

  it('reports broken links, test cases and loops', () => {
    const idx = buildIndex(
      [req('REQ-1', 'refines: [REQ-9, TC-1, REQ-1]\n'), req('REQ-2', 'refines: [REQ-3]\n'), req('REQ-3', 'refines: [REQ-2]\n'), test('TC-1', ['REQ-1'])],
      null,
    );
    const msgs = idx.problems.map((p) => p.message);
    expect(msgs).toContain("REQ-1 refines REQ-9, which doesn't exist.");
    expect(msgs).toContain('REQ-1 refines TC-1, which is a test case.');
    expect(msgs).toContain('REQ-1 refines itself.');
    expect(msgs.filter((m) => m.includes('loop')).length).toBe(2); // REQ-2 and REQ-3
    // A loop covers nothing, and doesn't hang.
    expect(coverage(idx).untested.map((r) => r.id)).toEqual(['REQ-2', 'REQ-3']);
    expect(columns(buildGraph(idx)).filter((c) => c.type === 'req').length).toBeGreaterThan(0);
  });

  it('draws a column per level in the graph', () => {
    const g = buildGraph(buildIndex(files(), null));
    expect(g.fwd.get('req:REQ-10')).toEqual(['req:REQ-1', 'req:REQ-2']);
    const reqCols = columns(g).filter((c) => c.type === 'req');
    expect(reqCols.map((c) => c.nodes.map((n) => n.label))).toEqual([['REQ-10'], ['REQ-1', 'REQ-2'], ['REQ-3']]);
    expect(g.byKey.get('req:REQ-10')!.gap).toBeUndefined();
  });

  it('keeps refines per variant', () => {
    const idx = buildIndex(files([req('REQ-4', 'refines: [REQ-10]\nvariants: [pro]\n')]), 'variants:\n  pro: { name: Pro }\n');
    expect(idx.refinedBy.get('REQ-10')!.map((r) => r.id)).toEqual(['REQ-1', 'REQ-2', 'REQ-4']);
    expect(forVariant(idx, 'base').refinedBy.get('REQ-10')!.map((r) => r.id)).toEqual(['REQ-1', 'REQ-2']);
    // REQ-4 (Pro only) has no test case: for Pro, REQ-10 isn't covered.
    expect(coverage(forVariant(idx, 'pro')).untested.map((r) => r.id)).toContain('REQ-10');
  });

  it('is changed in bulk, with reviews, and never to itself', () => {
    const idx = buildIndex(files([test('TC-9', ['REQ-1'])]), null);
    const items = ['REQ-1', 'REQ-2', 'TC-9'].map((id) => idx.byId.get(id)!);
    const c = bulkChanges(items, { set: {}, add: { refines: ['REQ-2'] }, remove: {} }, idx);
    expect(c.get('requirements/REQ-1.md')).toEqual({ refines: ['REQ-10', 'REQ-2'], reviewed: { 'REQ-10': fp('REQ-10'), 'REQ-2': fp('REQ-2') } });
    expect(c.has('requirements/REQ-2.md')).toBe(false); // it can't refine itself
    expect(c.has('tests/TC-9.md')).toBe(false); // test cases don't refine
  });

  it('starts a new refining requirement with the link reviewed, and exports it', () => {
    expect(newItemText('requirement', { id: 'REQ-5', title: 'Five', status: 'draft', refines: ['REQ-10'], reviewed: { 'REQ-10': 'abc' } })).toBe(
      '---\nid: REQ-5\ntitle: Five\nstatus: draft\nrefines: [REQ-10]\nreviewed:\n  REQ-10: "abc"\n---\n',
    );
    const sheet = tables(buildIndex(files(), null), { obsolete: false, component: null, runs: [] }).requirements;
    const col = (h: string) => sheet.columns.findIndex((c) => c.header === h);
    const row = sheet.rows.find((r) => r[0] === 'REQ-10')!;
    expect([row[col('Refined by')], row[col('Covered')]]).toEqual(['REQ-1, REQ-2', 'Through refinements']);
  });
});
