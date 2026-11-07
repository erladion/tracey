import { describe, expect, it } from 'vitest';
import { buildIndex } from '../src/core/model';
import { buildGraph, columns, subgraph, walk } from '../src/core/graph';
import { fit, graphSvg, xml } from '../src/core/graphsvg';
import { projectFiles } from '../src/core/sample';

const files = Object.entries(projectFiles(true))
  .filter(([p]) => p.endsWith('.md') && p !== 'README.md')
  .map(([path, text]) => ({ path, text }));
const index = buildIndex(files, projectFiles(true)['trace.yml']);

describe('graph', () => {
  it('links issues → requirements → test cases → components', () => {
    const g = buildGraph(index);
    expect(g.fwd.get('issue:PROJ-466')).toEqual(['req:REQ-07']);
    expect(g.fwd.get('req:REQ-07')).toEqual(['test:TC-101', 'test:TC-102']);
    expect(g.fwd.get('test:TC-140')).toEqual(['component:auth']);
    expect([...walk('test:TC-140', g.back)].sort()).toEqual(['issue:PROJ-490', 'req:REQ-22', 'req:REQ-40']);
  });

  it('marks gaps', () => {
    const g = buildGraph(index);
    expect(g.byKey.get('req:REQ-19')!.gap).toMatch(/No test case/);
    expect(g.byKey.get('component:export')!.gap).toMatch(/No test case covers/);
    expect(g.byKey.get('req:REQ-07')!.gap).toBeUndefined();
    expect([g.byKey.get('req:REQ-19')!.tag, g.byKey.get('component:export')!.tag, g.byKey.get('req:REQ-07')!.tag]).toEqual(['No tests', 'No tests', undefined]);
  });

  it('filters to what is connected', () => {
    const g = buildGraph(index, { component: 'billing' });
    expect(g.nodes.map((n) => n.key).sort()).toEqual(['component:billing', 'issue:PROJ-481', 'req:REQ-12', 'test:TC-110', 'test:TC-111']);
    const s = buildGraph(index, { query: 'sso' });
    expect(s.nodes.map((n) => n.key)).toContain('req:REQ-22');
  });

  it('orders columns to follow their links', () => {
    const cols = columns(buildGraph(index));
    expect(cols.map((c) => c.type)).toEqual(['commit', 'issue', 'req', 'test', 'component']);
    const tests = cols[3].nodes.map((n) => n.label);

    expect(tests.indexOf('TC-101')).toBeLessThan(tests.indexOf('TC-110'));
  });
});

import { linkCommits, commitsFor } from '../src/core/commits';

describe('commits', () => {
  const commit = (hash: string, subject: string, files: string[] = []) => ({ hash, author: 'A', date: '2026-11-01T10:00:00Z', subject, body: '', files });
  const linked = linkCommits(
    [
      commit('aaaa1111', 'PROJ-466: exponential back-off for retries', ['src/payments/retry.ts']),
      commit('bbbb2222', 'Pull request #12: PROJ-999 new export button', ['src/export/pdf.ts']),
      commit('cccc3333', 'Bump UTF-8 handling, see REQ-22'),
      commit('dddd4444', 'Tidy up'),
    ],
    index,
  );

  it('reads Jira keys and item IDs from messages, and components from files', () => {
    expect(linked[0]).toMatchObject({ issues: ['PROJ-466'], items: [], components: ['payments'] });
    expect(linked[1].issues).toEqual(['PROJ-999']);
    expect(linked[2]).toMatchObject({ issues: [], items: ['REQ-22'] });
  });

  it('reaches requirements and test cases through issues', () => {
    expect(commitsFor(index.byId.get('REQ-07')!, linked, index).map((c) => c.via)).toEqual([['PROJ-466']]);
    expect(commitsFor(index.byId.get('TC-102')!, linked, index).map((c) => c.linked.commit.hash)).toEqual(['aaaa1111']);
  });

  it('adds commits to the graph, and issues no requirement names as gaps', () => {
    const g = buildGraph(index, {}, linked);
    expect(g.fwd.get('commit:aaaa1111')).toEqual(['issue:PROJ-466']);
    expect(g.byKey.get('issue:PROJ-999')!.gap).toMatch(/no requirement/);
    expect(g.byKey.has('commit:dddd4444')).toBe(false);
    expect([...walk('commit:aaaa1111', g.fwd)]).toContain('test:TC-102');
  });
});

describe('graph picture', () => {
  it('keeps only the given nodes and the links between them', () => {
    const g = buildGraph(index);
    const keep = new Set(['req:REQ-07', ...walk('req:REQ-07', g.fwd), ...walk('req:REQ-07', g.back)]);
    const s = subgraph(g, keep);
    expect(s.nodes.map((n) => n.key).sort()).toEqual([...keep].sort());
    expect(s.edges.every((e) => keep.has(e.from) && keep.has(e.to))).toBe(true);
    expect(s.fwd.get('req:REQ-07')).toEqual(['test:TC-101', 'test:TC-102']);
  });

  it('draws what is shown as a standalone SVG', () => {
    const g = buildGraph(index);
    const nodes = g.nodes.slice(0, 3).map((node, i) => ({ x: 0, y: 36 + i * 68, node, selected: i === 0, dim: i === 2 }));
    const svg = graphSvg({ width: 210, height: 250, nodeW: 210, nodeH: 54, heads: [{ x: 0, label: 'Requirements & more', count: 3 }], nodes, edges: [{ d: 'M 0 0 L 1 1', hot: true }] });
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain('Requirements &amp; more');
    expect(svg).toContain(nodes[0].node.label);
    expect(svg).toContain('opacity="0.45"');
    expect(svg).toContain('stroke-width="2.5"');
    expect(new DOMParserLike(svg).ok).toBe(true);
  });

  it('cuts long text to fit', () => {
    expect(fit('short', 100, 7)).toBe('short');
    expect(fit('Payment fails with a retry-exhausted message', 70, 7)).toBe('Payment f…');
    expect(xml('<a & "b">')).toBe('&lt;a &amp; &quot;b&quot;&gt;');
  });
});

// Balanced tags, without a browser.
class DOMParserLike {
  ok: boolean;
  constructor(svg: string) {
    const stack: string[] = [];
    let ok = true;
    for (const m of svg.matchAll(/<(\/?)([a-zA-Z]+)[^>]*?(\/?)>/g)) {
      if (m[3]) continue;
      if (m[1]) ok &&= stack.pop() === m[2];
      else stack.push(m[2]);
    }
    this.ok = ok && stack.length === 0;
  }
}
