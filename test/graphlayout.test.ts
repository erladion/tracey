import { describe, expect, it } from 'vitest';
import { buildIndex, type SourceFile } from '../src/core/model';
import { buildGraph, columns } from '../src/core/graph';
import { bandIndex, edgePath, freeY, layoutGraph, pack } from '../src/core/graphlayout';

const O = { W: 160, H: 54, GAP: 60, ROW: 68, TOP: 36, INDENT: 16 };
const req = (id: string, front = ''): SourceFile => ({ path: `requirements/${id}.md`, text: `---\nid: ${id}\ntitle: ${id}\nstatus: draft\n${front}---\n` });
const test = (id: string, verifies: string[]): SourceFile => ({ path: `tests/${id}.md`, text: `---\nid: ${id}\ntitle: ${id}\nstatus: ready\nverifies: [${verifies.join(', ')}]\n---\n` });

// REQ-10 is broken down into REQ-1 and REQ-2, REQ-2 into REQ-3. Tests: TC-1..TC-5.
const graph = () =>
  buildGraph(
    buildIndex(
      [
        req('REQ-10'),
        req('REQ-1', 'refines: [REQ-10]\n'),
        req('REQ-2', 'refines: [REQ-10]\n'),
        req('REQ-3', 'refines: [REQ-2]\n'),
        test('TC-1', ['REQ-1']),
        test('TC-2', ['REQ-1']),
        test('TC-3', ['REQ-3']),
        test('TC-4', ['REQ-1']),
        test('TC-5', ['REQ-3']),
      ],
      null,
    ),
  );

describe('graph layout', () => {
  it('packs nodes near where they want to be, in order, a row apart', () => {
    expect(pack([100, 100, 300], 68, 36)).toEqual([66, 134, 300]);
    expect(pack([NaN, 200, NaN], 68, 36)).toEqual([132, 200, 268]);
    expect(pack([0, 10], 68, 36)).toEqual([36, 104]); // not above the headings
    expect(pack([NaN, NaN], 68, 36)).toEqual([36, 104]);
  });

  it('puts each node level with what it links to', () => {
    const g = graph();
    const cols = columns(g);
    const lay = layoutGraph(g, cols, O);
    const y = (k: string) => lay.pos.get(k)!.y;
    // The test cases (tallest) are spaced evenly; REQ-3 sits level with its tests, not centred.
    expect(y('req:REQ-3')).toBe((y('test:TC-3') + y('test:TC-5') + y('req:REQ-2')) / 3);
    expect(Math.abs(y('req:REQ-1') - (y('test:TC-1') + y('test:TC-2') + y('test:TC-4') + y('req:REQ-10')) / 4)).toBeLessThan(O.ROW);
  });

  it('routes a link that skips columns between the nodes it passes', () => {
    const g = graph();
    const lay = layoutGraph(g, columns(g), O);
    // REQ-1 (level 2) to TC-1 crosses the level 3 column, where REQ-3 is.
    const d = edgePath(lay, 'req:REQ-1', 'test:TC-1', O);
    const level3 = lay.pos.get('req:REQ-3')!;
    // The first curve ends where the link crosses the level 3 column: M … C …, …, x lane H …
    const lane = Number(d.match(/C [^,]+, [^,]+, [\d.]+ ([\d.]+) H/)![1]);
    expect(lane < level3.y - 4 || lane > level3.y + O.H + 4).toBe(true);
    expect(freeY(lay, level3.col, level3.y + 10, O)).not.toBe(level3.y + 10);
  });

  it('shows the levels in one column, each under the one it refines', () => {
    const g = graph();
    const cols = columns(g, { levels: 'together' });
    const reqCol = cols.find((c) => c.type === 'req')!;
    expect(cols.filter((c) => c.type === 'req')).toHaveLength(1);
    expect(reqCol.nodes.map((n) => n.label)).toEqual(['REQ-10', 'REQ-1', 'REQ-2', 'REQ-3']);
    const lay = layoutGraph(g, cols, O);
    expect(['req:REQ-10', 'req:REQ-2', 'req:REQ-3'].map((k) => lay.pos.get(k)!.w)).toEqual([160, 144, 128]);
    expect(edgePath(lay, 'req:REQ-2', 'req:REQ-3', O)).toMatch(/^M \d+ [\d.]+ V [\d.]+ Q/); // an elbow
  });
});

describe('bandIndex', () => {
  it('finds what reaches into a band, in the original order, short and tall alike', () => {
    const things = [
      { n: 'a', y: [0, 50] },
      { n: 'tall', y: [0, 100000] },
      { n: 'b', y: [2900, 3100] },
      { n: 'c', y: [5000, 5050] },
      { n: 'd', y: [3050, 3060] },
    ];
    const near = bandIndex(things, (t) => t.y as [number, number], 1000, 24);
    expect(near(3000, 3055).map((t) => t.n)).toEqual(['tall', 'b', 'd']);
    expect(near(0, 10).map((t) => t.n)).toEqual(['a', 'tall']);
    expect(near(60, 2800).map((t) => t.n)).toEqual(['tall']);
    expect(near(200000, 300000)).toEqual([]);
  });
});
