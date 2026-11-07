// The traceability graph: commits → Jira issues → requirements → test cases → components.
//
// Edges point downstream: a commit to the Jira issues (or items) its message names, an
// issue to the requirements and test cases linked to it (links.ts: front matter,
// labels, a field, mentions, remote links), a requirement to the test cases verifying
// it, a test case to the components it's tagged with. Pure, so it's tested without a
// browser.
import { linksOf, type Item, type LinkState, type ProjectIndex } from './model';
import type { LinkedCommit } from './commits';
import { buildIssueLinks, type IssueLinks, type LinkSource } from './links';
import type { JiraIssue } from '../shared/api';

export type NodeType = 'commit' | 'issue' | 'req' | 'test' | 'component';

export const COLUMN_ORDER: NodeType[] = ['commit', 'issue', 'req', 'test', 'component'];

export interface GNode {
  key: string; // unique across types: "req:REQ-07", "component:payments"
  type: NodeType;
  label: string; // the ID, Jira key or component name
  sub: string; // title, or the component's paths
  item?: Item;
  commit?: LinkedCommit;
  issue?: JiraIssue; // what Jira says about it, when read
  status?: string;
  gap?: string; // why this node is a gap, if it is
  tag?: string; // the gap in a word or two, shown on the node: "No tests"
  warn?: boolean; // a gap that's a problem now (suspect, broken), not just missing
}

export interface GEdge {
  from: string;
  to: string;
  state?: LinkState; // requirement → test case links
  sources?: LinkSource[]; // issue → item links: where the link is written
}

export interface Graph {
  nodes: GNode[];
  edges: GEdge[];
  byKey: Map<string, GNode>;
  fwd: Map<string, string[]>;
  back: Map<string, string[]>;
}

export interface GraphFilter {
  component?: string; // only what's connected to items tagged with it
  query?: string; // only what's connected to matching nodes
  hideObsolete?: boolean;
  commits?: number; // how many of the newest linked commits to show (0: none)
}

const live = (it: Item) => it.status !== 'obsolete';

function assemble(nodes: GNode[], edges: GEdge[]): Graph {
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const kept = edges.filter((e) => byKey.has(e.from) && byKey.has(e.to));
  const fwd = new Map<string, string[]>();
  const back = new Map<string, string[]>();
  for (const e of kept) {
    fwd.set(e.from, [...(fwd.get(e.from) ?? []), e.to]);
    back.set(e.to, [...(back.get(e.to) ?? []), e.from]);
  }
  return { nodes, edges: kept, byKey, fwd, back };
}

// Only the given nodes, and the links between them.
export const subgraph = (graph: Graph, keep: Set<string>): Graph => assemble(graph.nodes.filter((n) => keep.has(n.key)), graph.edges);

export function walk(start: string, map: Map<string, string[]>): Set<string> {
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length) {
    for (const n of map.get(queue.shift()!) ?? []) {
      if (!seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
    }
  }
  return seen;
}

export function buildGraph(index: ProjectIndex, filter: GraphFilter = {}, commits: LinkedCommit[] = [], links: IssueLinks = buildIssueLinks(index)): Graph {
  const nodes: GNode[] = [];
  const edges: GEdge[] = [];
  const items = index.items.filter((i) => !filter.hideObsolete || live(i));
  const components = new Map(index.config.components.map((c) => [c.key, c]));
  const usedComponents = new Set<string>();
  const issues = new Set<string>();

  for (const it of items) {
    const key = `${it.kind === 'requirement' ? 'req' : 'test'}:${it.id}`;
    const node: GNode = { key, type: it.kind === 'requirement' ? 'req' : 'test', label: it.id, sub: it.title, item: it, status: it.status };
    nodes.push(node);
    for (const l of links.byItem.get(it.id) ?? []) {
      issues.add(l.issue);
      edges.push({ from: `issue:${l.issue}`, to: key, sources: l.sources });
    }
    if (it.kind === 'requirement') {
      const tests = linksOf(index, it).filter((l) => !filter.hideObsolete || live(l.test));
      for (const l of tests) edges.push({ from: key, to: `test:${l.test.id}`, state: l.state });
      if (live(it) && !tests.some((l) => live(l.test))) [node.gap, node.tag] = ['No test case verifies this requirement.', 'No tests'];
    } else {
      for (const c of it.components) {
        usedComponents.add(c);
        edges.push({ from: key, to: `component:${c}` });
      }
      if (live(it)) {
        const links = linksOf(index, it);
        const missing = it.verifies.filter((v) => index.byId.get(v)?.kind !== 'requirement');
        const suspect = links.filter((l) => l.state === 'suspect').map((l) => l.req.id);
        if (missing.length) [node.gap, node.warn, node.tag] = [`Verifies ${missing.join(', ')}, which ${missing.length === 1 ? "doesn't" : "don't"} exist.`, true, 'Broken link'];
        else if (suspect.length) [node.gap, node.warn, node.tag] = [`${suspect.join(', ')} changed since this test case was reviewed.`, true, 'Suspect'];
        else if (!it.verifies.length) [node.gap, node.tag] = ['Verifies no requirement.', 'No requirement'];
      }
    }
  }
  // Commits, newest first, that name an issue or an item.
  const commitIssues = new Set<string>();
  const shown = commits.filter((c) => c.issues.length || c.items.some((id) => index.byId.has(id))).slice(0, filter.commits ?? 50);
  for (const c of shown) {
    const key = `commit:${c.commit.hash}`;
    nodes.push({ key, type: 'commit', label: c.commit.hash.slice(0, 8), sub: c.commit.subject, commit: c });
    for (const j of c.issues) {
      commitIssues.add(j);
      edges.push({ from: key, to: `issue:${j}` });
    }
    for (const id of c.items) {
      const it = index.byId.get(id);
      if (it) edges.push({ from: key, to: `${it.kind === 'requirement' ? 'req' : 'test'}:${id}` });
    }
  }
  const issueNode = (j: string): GNode => {
    const is = links.issues.get(j);
    return { key: `issue:${j}`, type: 'issue', label: j, sub: is ? is.summary || 'Jira issue' : 'Jira issue', status: is?.status, issue: is };
  };
  for (const j of [...issues].sort()) nodes.push(issueNode(j));
  // Issues that code changed for, but nothing links to a requirement or test case.
  for (const j of [...commitIssues].filter((j) => !issues.has(j)).sort())
    nodes.push({ ...issueNode(j), gap: 'Commits name this issue, but it’s linked to no requirement or test case.', tag: 'Not linked' });
  const testedComponents = new Set(items.filter((i) => i.kind === 'testcase' && live(i)).flatMap((i) => i.components));
  for (const key of new Set([...components.keys(), ...usedComponents])) {
    const c = components.get(key);
    nodes.push({
      key: `component:${key}`,
      type: 'component',
      label: c?.name ?? key,
      sub: c ? c.paths.join(', ') || 'no paths' : 'not in trace.yml',
      ...(testedComponents.has(key) ? {} : { gap: 'No test case covers this component.', tag: 'No tests' }),
    });
  }

  let graph = assemble(nodes, edges);

  // Filters keep the matching nodes and everything upstream and downstream of them.
  const seeds: ((n: GNode) => boolean)[] = [];
  if (filter.component) {
    const c = filter.component;
    seeds.push((n) => n.key === `component:${c}` || !!n.item?.components.includes(c));
  }
  const q = filter.query?.trim().toLowerCase();
  if (q) seeds.push((n) => n.label.toLowerCase().includes(q) || n.sub.toLowerCase().includes(q));
  if (seeds.length) {
    const keep = new Set<string>();
    for (const n of graph.nodes) {
      if (!seeds.every((s) => s(n))) continue;
      keep.add(n.key);
      for (const k of walk(n.key, graph.fwd)) keep.add(k);
      for (const k of walk(n.key, graph.back)) keep.add(k);
    }
    graph = assemble(
      graph.nodes.filter((n) => keep.has(n.key)),
      graph.edges,
    );
  }
  return graph;
}

// Columns in order, each sorted to keep edges short: requirements by ID, every other
// column by the average position of what it's linked to (barycentre ordering).
export function columns(graph: Graph): { type: NodeType; nodes: GNode[] }[] {
  const of = (t: NodeType) => graph.nodes.filter((n) => n.type === t);
  const pos = new Map<string, number>();
  const place = (list: GNode[]) => list.forEach((n, i) => pos.set(n.key, i));
  const byNeighbours = (list: GNode[], neighbours: (n: GNode) => string[]) => {
    const score = (n: GNode) => {
      const p = neighbours(n)
        .map((k) => pos.get(k))
        .filter((x): x is number => x != null);
      return p.length ? p.reduce((a, b) => a + b, 0) / p.length : Infinity;
    };
    return list.map((n, i) => ({ n, s: score(n), i })).sort((a, b) => a.s - b.s || a.i - b.i).map((x) => x.n);
  };
  const reqs = of('req');
  place(reqs);
  const tests = byNeighbours(of('test'), (n) => graph.back.get(n.key) ?? []);
  place(tests);
  const comps = byNeighbours(of('component'), (n) => graph.back.get(n.key) ?? []);
  place(comps);
  const issues = byNeighbours(of('issue'), (n) => graph.fwd.get(n.key) ?? []);
  place(issues);
  const commits = byNeighbours(of('commit'), (n) => (graph.fwd.get(n.key) ?? []).filter((k) => k.startsWith('issue:')));
  return [
    { type: 'commit' as const, nodes: commits },
    { type: 'issue' as const, nodes: issues },
    { type: 'req' as const, nodes: reqs },
    { type: 'test' as const, nodes: tests },
    { type: 'component' as const, nodes: comps },
  ];
}
