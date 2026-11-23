// The same project as Tracey's Markdown files and as Sphinx-Needs MyST files draws the
// same graph: nodes, links, gaps, columns, layout, and the picture.
import { describe, expect, it } from 'vitest';
import type { Commit, JiraIssue } from '../src/shared/api';
import { parseConfig } from '../src/core/config';
import { buildIndex, type ProjectIndex } from '../src/core/model';
import { buildGraph, columns, type Graph } from '../src/core/graph';
import { layoutGraph } from '../src/core/graphlayout';
import { linkCommits } from '../src/core/commits';
import { buildIssueLinks } from '../src/core/links';
import { explodeNeeds, readNeedFile, splitNeedPath, writeNeed, type NeedContext } from '../src/core/myst';
import { projectFiles } from '../src/core/sample';

// The sample project, with Sphinx-style IDs (REQ_07) and a declared type with a link.
const sample = projectFiles(true);
const sphinxIds = (t: string) => t.replace(/\b(REQ|TC|RSK)-(\d+)\b/g, '$1_$2');
const TRACE = `${sphinxIds(sample['trace.yml'])
  .replace('prefix: REQ-', 'prefix: REQ_')
  .replace('prefix: TC-', 'prefix: TC_')}
types:
  risk: { name: Risk, prefix: RSK_, dir: risks }
links:
  mitigates: { name: Mitigates, reverse: Mitigated by, from: requirement, to: risk }
`;
const markdown = [
  ...Object.entries(sample)
    .filter(([p]) => p.endsWith('.md') && p !== 'README.md')
    .map(([path, text]) => ({ path: sphinxIds(path), text: sphinxIds(text) })),
  { path: 'risks/RSK_1-double-charge.md', text: '---\nid: RSK_1\ntitle: Double charge\nstatus: draft\n---\nA retry charges twice.\n' },
  { path: 'risks/RSK_2-lockout.md', text: '---\nid: RSK_2\ntitle: Lockout\nstatus: draft\n---\n' },
].map((f) => (f.path === 'requirements/REQ_07-payment-retry.md' ? { ...f, text: f.text.replace(/\n---\n/, '\nmitigates: [RSK_1]\n---\n') } : f));

const md = buildIndex(markdown, TRACE);

// The same items written as needs, one MyST file per type, by Tracey's own writer.
function asSphinx(): ProjectIndex {
  const configText = `${TRACE}sphinx-needs:\n  dir: docs\n`;
  const config = parseConfig(configText).config;
  const ctx: NeedContext = { config, declared: null, kindOfId: (id) => md.byId.get(id)?.kind ?? null };
  const files = new Map<string, string>();
  for (const it of md.items) {
    const file = `docs/${it.kind}.md`;
    files.set(file, writeNeed(files.get(file) ?? '', { file, id: it.id, n: 1 }, markdown.find((f) => f.path === it.path)!.text, ctx, it.kind));
  }
  const needs = [...files].map(([path, text]) => readNeedFile(path, text, config, null));
  return buildIndex(explodeNeeds(needs, config, null), configText);
}
const sphinx = asSphinx();

// Commits and Jira issues naming items by their IDs.
const commits: Commit[] = [
  { hash: 'a1', author: 'A', date: '2026-11-01T10:00:00Z', subject: 'Retry payments (REQ_07)', body: '', files: ['src/payments/retry.ts'] },
  { hash: 'b2', author: 'B', date: '2026-11-02T10:00:00Z', subject: 'PROJ-466: back off', body: 'Covered by TC_102.', files: ['src/billing/tax.ts'] },
];
const issues: JiraIssue[] = [
  { key: 'PROJ-500', summary: 'SSO for REQ_40', status: 'Open', statusCategory: 'new', type: 'Story', labels: ['REQ_22'], fixVersions: [], description: '', field: ['TC_140'], remoteLinks: null },
];

function picture(index: ProjectIndex) {
  const links = buildIssueLinks(index, issues);
  const g = buildGraph(index, {}, linkCommits(commits, index, links), links);
  const nodes = g.nodes.map(({ item: _item, commit: _commit, issue: _issue, ...n }) => n);
  const cols = columns(g).map((c) => ({ ...c, nodes: c.nodes.map((n) => n.key), tree: c.tree && { depth: [...c.tree.depth], parent: [...c.tree.parent] } }));
  const lay = layoutGraph(g, columns(g), { W: 180, H: 44, GAP: 80, ROW: 56, TOP: 30, INDENT: 16 });
  return { g, nodes, edges: g.edges, typeOrder: g.typeOrder, cols, lay: JSON.stringify(lay, (_k, v) => (v instanceof Map ? [...v] : v)) };
}

describe('the graph of a Sphinx-Needs project', () => {
  const a = picture(md);
  const b = picture(sphinx);

  it('has the same items, read without problems', () => {
    expect(sphinx.items.map((i) => i.id)).toEqual(md.items.map((i) => i.id));
    expect(sphinx.problems.filter((p) => p.code !== 'sphinx')).toEqual(md.problems);
  });

  it('draws the same nodes, links, gaps and columns', () => {
    expect(b.nodes).toEqual(a.nodes);
    expect(b.edges).toEqual(a.edges);
    expect(b.typeOrder).toEqual(a.typeOrder);
    expect(b.cols).toEqual(a.cols);
  });

  it('lays them out the same', () => {
    expect(b.lay).toEqual(a.lay);
  });

  it('links commits and Jira issues naming Sphinx-style IDs', () => {
    const fwd = (g: Graph, k: string) => g.fwd.get(k) ?? [];
    expect(fwd(b.g, 'commit:a1')).toContain('req:REQ_07');
    expect(fwd(b.g, 'commit:b2')).toEqual(expect.arrayContaining(['issue:PROJ-466', 'test:TC_102']));
    expect(fwd(b.g, 'issue:PROJ-500')).toEqual(expect.arrayContaining(['req:REQ_40', 'req:REQ_22', 'test:TC_140']));
    expect(fwd(b.g, 'item:RSK_1')).toEqual(['req:REQ_07']);
  });
});
