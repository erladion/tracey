// The traceability graph: commits → Jira issues → requirements → test cases → components.
//
// Edges point downstream: a commit to the Jira issues (or items) its message names, an
// issue to the requirements and test cases linked to it (links.ts: front matter,
// labels, a field, mentions, remote links), a requirement to the requirements refining
// it and the test cases verifying it, a test case to the components it's tagged with.
// Links of the types trace.yml declares go the same way: from the item linked to, to the
// item naming it. Refining requirements get a column each level down, and each declared
// item type a column of its own. Pure, so it's tested without a browser.
import { byEvidence, checkRules, itemLinks, linksOf, refinesOf, verification, type Item, type LinkState, type ProjectIndex } from './model';
import { typeOf, type TraceConfig } from './config';
import type { LinkedCommit } from './commits';
import { buildIssueLinks, type IssueLinks, type LinkSource } from './links';
import type { JiraIssue } from '../shared/api';

export type NodeType = 'commit' | 'issue' | 'req' | 'test' | 'item' | 'component';

// An item's node: req:REQ-07, test:TC-101, item:RSK-3 (an item of a declared type).
export const nodeKey = (it: Pick<Item, 'kind' | 'id'>) => `${it.kind === 'requirement' ? 'req' : it.kind === 'testcase' ? 'test' : 'item'}:${it.id}`;

export interface GNode {
  key: string; // unique across types: "req:REQ-07", "component:payments"
  type: NodeType;
  label: string; // the ID, Jira key or component name
  sub: string; // title, or the component's paths
  item?: Item;
  itemType?: string; // items: their type (requirement, testcase, risk…)
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
  state?: LinkState; // links between items: whether the one naming the other is reviewed against it
  sources?: LinkSource[]; // issue → item links: where the link is written
}

export interface Graph {
  nodes: GNode[];
  edges: GEdge[];
  byKey: Map<string, GNode>;
  fwd: Map<string, string[]>;
  back: Map<string, string[]>;
  typeOrder: string[]; // item types, left to right
}

export interface GraphFilter {
  component?: string; // only what's connected to items tagged with it
  query?: string; // only what's connected to matching nodes
  hideObsolete?: boolean;
  commits?: number; // how many of the newest linked commits to show (0: none)
}

const live = (it: Item) => it.status !== 'obsolete';

function assemble(nodes: GNode[], edges: GEdge[], typeOrder: string[]): Graph {
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const kept = edges.filter((e) => byKey.has(e.from) && byKey.has(e.to));
  const fwd = new Map<string, string[]>();
  const back = new Map<string, string[]>();
  for (const e of kept) {
    fwd.set(e.from, [...(fwd.get(e.from) ?? []), e.to]);
    back.set(e.to, [...(back.get(e.to) ?? []), e.from]);
  }
  return { nodes, edges: kept, byKey, fwd, back, typeOrder };
}

// Only the given nodes, and the links between them.
export const subgraph = (graph: Graph, keep: Set<string>): Graph => assemble(graph.nodes.filter((n) => keep.has(n.key)), graph.edges, graph.typeOrder);

// Item types left to right, following their links (from the item linked to, to the one
// naming it): risk → requirement when requirements mitigate risks; requirement →
// architecture when architecture implements requirements. Requirements first and test
// cases last among types at the same step.
export function typeOrder(config: TraceConfig): string[] {
  const keys = config.types.map((t) => t.key);
  const into = new Map(keys.map((k) => [k, [] as string[]]));
  for (const l of config.links) for (const f of l.from) for (const t of l.to) if (f !== t && into.has(f) && into.has(t)) into.get(f)!.push(t);
  const rank = new Map<string, number>();
  const visiting = new Set<string>();
  const rankOf = (k: string): number => {
    const known = rank.get(k);
    if (known != null) return known;
    if (visiting.has(k)) return 0; // a cycle of link types
    visiting.add(k);
    const r = Math.max(-1, ...into.get(k)!.map(rankOf)) + 1;
    visiting.delete(k);
    rank.set(k, r);
    return r;
  };
  const tie = (k: string) => (k === 'requirement' ? 0 : k === 'testcase' ? 2 : 1);
  return [...keys].sort((a, b) => rankOf(a) - rankOf(b) || tie(a) - tie(b) || keys.indexOf(a) - keys.indexOf(b));
}

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
  const { covered, exempt } = verification(index);
  // The first rule each item misses.
  const ruleGap = new Map<string, { tag: string; text: string }>();
  for (const r of checkRules(index)) for (const it of r.missing) if (!ruleGap.has(it.id)) ruleGap.set(it.id, { tag: r.rule.tag, text: r.rule.text });

  for (const it of items) {
    const key = nodeKey(it);
    const node: GNode = { key, type: it.kind === 'requirement' ? 'req' : it.kind === 'testcase' ? 'test' : 'item', label: it.id, sub: it.title, item: it, itemType: it.kind, status: it.status };
    nodes.push(node);
    for (const l of links.byItem.get(it.id) ?? []) {
      issues.add(l.issue);
      edges.push({ from: `issue:${l.issue}`, to: key, sources: l.sources });
    }
    if (it.kind === 'requirement') {
      const tests = linksOf(index, it).filter((l) => !filter.hideObsolete || live(l.test));
      for (const l of tests) edges.push({ from: key, to: `test:${l.test.id}`, state: l.state });
      const { up, down } = refinesOf(index, it);
      for (const l of down) if (!filter.hideObsolete || live(l.child)) edges.push({ from: key, to: `req:${l.child.id}`, state: l.state });
      const missing = it.refines.filter((v) => index.byId.get(v)?.kind !== 'requirement');
      const suspect = up.filter((l) => l.state === 'suspect').map((l) => l.parent.id);
      if (!live(it)) {
        // Obsolete: nothing to look at.
      } else if (missing.length) [node.gap, node.warn, node.tag] = [`Refines ${missing.join(', ')}, which ${missing.length === 1 ? "doesn't" : "don't"} exist or isn't a requirement.`, true, 'Broken link'];
      else if (suspect.length) [node.gap, node.warn, node.tag] = [`${suspect.join(', ')} changed since this requirement was reviewed against it.`, true, 'Suspect'];
      else if (!covered.has(it.id) && !exempt.has(it.id)) {
        if (byEvidence(it.verification) && !down.length) [node.gap, node.tag] = [`To be verified by ${it.verification}, but no evidence is recorded, and no test case verifies it.`, 'No evidence'];
        else [node.gap, node.tag] = [down.length ? 'No test case verifies this requirement, nor all the requirements refining it.' : 'No test case verifies this requirement.', 'No tests'];
      }
    } else if (it.kind === 'testcase') {
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
    // Links of the declared types: edges, and what's wrong with them.
    const { out } = itemLinks(index, it);
    for (const l of out) if (!filter.hideObsolete || live(l.to)) edges.push({ from: nodeKey(l.to), to: key, state: l.state });
    if (live(it) && !node.warn) {
      const broken = Object.entries(it.links).flatMap(([k, ids]) => ids.filter((id) => !out.some((l) => l.def.key === k && l.to.id === id)));
      const suspect = out.filter((l) => l.state === 'suspect' && live(l.to)).map((l) => l.to.id);
      if (broken.length) [node.gap, node.warn, node.tag] = [`Links to ${broken.join(', ')}, which ${broken.length === 1 ? "doesn't" : "don't"} exist or can't be linked that way.`, true, 'Broken link'];
      else if (suspect.length) [node.gap, node.warn, node.tag] = [`${suspect.join(', ')} changed since this ${typeOf(index.config, it.kind).name.toLowerCase()} was reviewed against it.`, true, 'Suspect'];
    }
    const rule = ruleGap.get(it.id);
    if (live(it) && !node.gap && rule) [node.gap, node.tag] = [rule.text, rule.tag];
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
      if (it) edges.push({ from: key, to: nodeKey(it) });
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

  const order = typeOrder(index.config);
  let graph = assemble(nodes, edges, order);

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
      order,
    );
  }
  return graph;
}

// Columns left to right: commits, issues, the item types in their order (requirements a
// column per level of refinement), components. Requirements at the top level are sorted
// by ID; every other column by the average position of what it's linked to.
export interface Column {
  type: NodeType;
  depth: number; // requirements in separate columns: the level (0 = top)
  itemType?: string;
  nodes: GNode[];
  // Requirements in one column: each one's level, and the requirement it's shown under.
  tree?: { depth: Map<string, number>; parent: Map<string, string> };
}

// levels: 'separate' gives each level of refinement a column; 'together' keeps all
// requirements in one, each under the requirement it refines.
export function columns(graph: Graph, opts: { levels?: 'separate' | 'together' } = {}): Column[] {
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
  // A requirement's level: one more than the deepest requirement it refines.
  const parents = (n: GNode) => (graph.back.get(n.key) ?? []).filter((k) => k.startsWith('req:'));
  const depth = new Map<string, number>();
  const levelOf = (n: GNode, path = new Set<string>()): number => {
    const known = depth.get(n.key);
    if (known != null) return known;
    if (path.has(n.key)) return 0; // a loop
    path.add(n.key);
    const d = Math.max(-1, ...parents(n).map((k) => levelOf(graph.byKey.get(k)!, path))) + 1;
    path.delete(n.key);
    depth.set(n.key, d);
    return d;
  };
  const reqs = of('req');
  for (const r of reqs) levelOf(r);
  const levels = Math.max(0, ...reqs.map((r) => depth.get(r.key)!)) + 1;
  const linkedFrom = (n: GNode) => graph.back.get(n.key) ?? [];
  const typeCols: Column[] = [];
  const order = graph.typeOrder.length ? graph.typeOrder : ['requirement', 'testcase'];
  const known = new Set(order);
  const extra = [...new Set(graph.nodes.filter((n) => n.type === 'item' && !known.has(n.itemType!)).map((n) => n.itemType!))];
  for (const t of [...order, ...extra]) {
    if (t === 'requirement' && opts.levels === 'together') {
      // Top-level ones in order, each followed by those refining it (by ID), depth first.
      // One refining several is shown under the first; loops go at the end.
      const top = reqs.filter((r) => depth.get(r.key) === 0);
      const roots = !top.some((r) => linkedFrom(r).some((k) => pos.has(k))) ? top : byNeighbours(top, linkedFrom);
      const tree = { depth: new Map<string, number>(), parent: new Map<string, string>() };
      const ordered: GNode[] = [];
      const byId = (a: GNode, b: GNode) => a.label.localeCompare(b.label, undefined, { numeric: true });
      const visit = (n: GNode, d: number, parent: string | null) => {
        if (tree.depth.has(n.key)) return;
        tree.depth.set(n.key, d);
        if (parent) tree.parent.set(n.key, parent);
        ordered.push(n);
        const kids = (graph.fwd.get(n.key) ?? []).filter((k) => k.startsWith('req:')).map((k) => graph.byKey.get(k)!);
        for (const k of kids.sort(byId)) visit(k, d + 1, n.key);
      };
      for (const r of roots) visit(r, 0, null);
      for (const r of reqs) visit(r, 0, null);
      place(ordered);
      typeCols.push({ type: 'req', depth: 0, nodes: ordered, tree });
    } else if (t === 'requirement') {
      for (let d = 0; d < levels; d++) {
        const here = reqs.filter((r) => depth.get(r.key) === d);
        // The top level by ID, unless something before it (a declared type) leads it.
        const ordered = d === 0 && !here.some((r) => linkedFrom(r).some((k) => pos.has(k))) ? here : byNeighbours(here, d === 0 ? linkedFrom : parents);
        place(ordered);
        typeCols.push({ type: 'req', depth: d, nodes: ordered });
      }
    } else {
      const nodes = byNeighbours(
        t === 'testcase' ? of('test') : graph.nodes.filter((n) => n.type === 'item' && n.itemType === t),
        (n) => [...linkedFrom(n), ...(graph.fwd.get(n.key) ?? [])],
      );
      place(nodes);
      typeCols.push({ type: t === 'testcase' ? 'test' : 'item', depth: 0, ...(t === 'testcase' ? {} : { itemType: t }), nodes });
    }
  }
  const comps = byNeighbours(of('component'), (n) => graph.back.get(n.key) ?? []);
  place(comps);
  const issues = byNeighbours(of('issue'), (n) => graph.fwd.get(n.key) ?? []);
  place(issues);
  const commits = byNeighbours(of('commit'), (n) => (graph.fwd.get(n.key) ?? []).filter((k) => k.startsWith('issue:')));
  return [
    { type: 'commit' as const, depth: 0, nodes: commits },
    { type: 'issue' as const, depth: 0, nodes: issues },
    ...typeCols,
    { type: 'component' as const, depth: 0, nodes: comps },
  ];
}
