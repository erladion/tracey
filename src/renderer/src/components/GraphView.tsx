// The traceability graph: issues → requirements → test cases → components. Click a
// node to trace everything upstream and downstream of it; "Show gaps" lights up what's
// missing or needs a look. "Hide what's faded" leaves only that, for large projects;
// what's shown saves as an SVG or PNG picture.
import { useEffect, useMemo, useRef, useState } from 'react';
import { buildGraph, columns, subgraph, walk, type GNode, type NodeType } from '../../../core/graph';
import { graphSvg, type GraphPicture } from '../../../core/graphsvg';
import { edgePath, layoutGraph } from '../../../core/graphlayout';
import type { LinkedCommit } from '../../../core/commits';
import { SOURCE_LABEL } from '../../../core/links';
import { byEvidence } from '../../../core/model';
import { isRunnable, typeName, typePlural, typeWord } from '../../../core/config';
import { addToWork } from './WorkList';
import type { Project } from '../project';
import { Icon } from '../icons';
import { StatusPill } from './bits';
import { load, save } from '../storage';
import { download } from '../download';
import { notify } from '../notify';

interface Props {
  project: Project;
  focus: string | null; // a node key to select on arrival
  onOpenId: (id: string) => void;
}

const MAX_W = 210; // node width, shrinking to MIN_W before the graph scrolls
const MIN_W = 160;
const H = 54; // node height
const ROW = 68; // vertical pitch
const MIN_GAP = 56; // between columns, where the edges run
const MAX_GAP = 160;
const TOP = 36; // room for the column headings

const LABELS: Record<NodeType, string> = { commit: 'Commits', issue: 'Jira issues', req: 'Requirements', test: 'Test cases', item: 'Items', component: 'Components' };
const TYPE_LABEL: Record<NodeType, string> = { commit: 'Commit', issue: 'Jira issue', req: 'Requirement', test: 'Test case', item: 'Item', component: 'Component' };
const REL: Record<NodeType, string> = { commit: 'commit', issue: 'issue', req: 'requirement', test: 'test case', item: 'item', component: 'component' };

export function GraphView({ project, focus, onOpenId }: Props) {
  const { index } = project;
  const [mode, setMode] = useState<'trace' | 'gaps'>('trace');
  const [selected, setSelected] = useState<string | null>(focus);
  const [component, setComponent] = useState('');
  const [query, setQuery] = useState('');
  const [hideObsolete, setHideObsolete] = useState(true);
  const [hideFaded, setHideFaded] = useState(() => load<boolean>('trace.graphHideFaded') ?? false);
  useEffect(() => save('trace.graphHideFaded', hideFaded), [hideFaded]);
  const [commitCount, setCommitCount] = useState(() => load<number>('trace.graphCommits') ?? 30);
  useEffect(() => save('trace.graphCommits', commitCount), [commitCount]);
  const [levelsTogether, setLevelsTogether] = useState(() => load<boolean>('trace.graphLevelsTogether') ?? false);
  useEffect(() => save('trace.graphLevelsTogether', levelsTogether), [levelsTogether]);
  const [zoom, setZoom] = useState(() => load<number>('trace.graphZoom') ?? 1);
  useEffect(() => save('trace.graphZoom', zoom), [zoom]);
  useEffect(() => {
    if (focus) {
      setSelected(focus);
      setMode('trace');
    }
  }, [focus]);

  const graph = useMemo(
    () => buildGraph(index, { component, query, hideObsolete, commits: commitCount }, project.commits, project.links),
    [index, component, query, hideObsolete, commitCount, project.commits, project.links],
  );

  const sel = selected && graph.byKey.has(selected) ? graph.byKey.get(selected)! : null;
  const up = useMemo(() => (sel ? walk(sel.key, graph.back) : new Set<string>()), [sel, graph]);
  const down = useMemo(() => (sel ? walk(sel.key, graph.fwd) : new Set<string>()), [sel, graph]);
  const gaps = graph.nodes.filter((n) => n.gap);

  // The tests in the selected node's trace, for the work list.
  const traceTests = useMemo(
    () =>
      sel
        ? [sel.key, ...up, ...down]
            .map((k) => graph.byKey.get(k)?.item)
            .filter((i): i is NonNullable<typeof i> => !!i && isRunnable(index.config, i.kind) && i.status !== 'obsolete')
        : [],
    [sel, up, down, graph, index.config],
  );
  const lit = (key: string) => (mode === 'gaps' ? !!graph.byKey.get(key)?.gap : !sel || key === sel.key || up.has(key) || down.has(key));
  const upPath = (k: string) => k === sel?.key || up.has(k);
  const downPath = (k: string) => k === sel?.key || down.has(k);

  // What's drawn: everything, or with "Hide what's faded" only the trace or the gaps.
  const hiding = hideFaded && (mode === 'gaps' || !!sel);
  const shown = useMemo(
    () => (hiding ? subgraph(graph, new Set(mode === 'gaps' ? gaps.map((n) => n.key) : [sel!.key, ...up, ...down])) : graph),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hiding, graph, mode, sel, up, down],
  );
  const cols = useMemo(() => columns(shown, { levels: levelsTogether ? 'together' : 'separate' }).filter((c) => c.nodes.length > 0), [shown, levelsTogether]);
  // With requirements refining others, a column per level (unless they're shown together).
  const levels = cols.filter((c) => c.type === 'req').length;
  const refining = useMemo(() => graph.edges.some((e) => e.from.startsWith('req:') && e.to.startsWith('req:')), [graph]);
  const colLabel = (c: { type: NodeType; depth: number; itemType?: string }) =>
    c.type === 'req' && levels > 1 ? (c.depth ? `Level ${c.depth + 1}` : 'Requirements, level 1') : c.type === 'item' ? typePlural(index.config, c.itemType!) : LABELS[c.type];
  // What a node is, in a word: "risk", "test case".
  const word = (n: GNode) => (n.type === 'item' ? typeWord(index.config, n.itemType!) : REL[n.type]);

  // Spread the columns over the width there is; scroll (or zoom out) when it's not enough.
  const scroller = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState(1000);
  // The part of the graph in view (in its own coordinates), to draw only that on a
  // large project.
  const [view, setView] = useState({ x: 0, y: 0, w: 2000, h: 1200 });
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let frame = 0;
    const look = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setView({ x: el.scrollLeft / zoom, y: el.scrollTop / zoom, w: el.clientWidth / zoom, h: el.clientHeight / zoom }));
    };
    const ro = new ResizeObserver(() => {
      setAvail(el.clientWidth);
      look();
    });
    ro.observe(el);
    el.addEventListener('scroll', look, { passive: true });
    look();
    return () => {
      ro.disconnect();
      el.removeEventListener('scroll', look);
      cancelAnimationFrame(frame);
    };
  }, [shown.nodes.length > 0, zoom]);
  const room = avail / zoom - 16; // a little room for the selection ring and a scrollbar
  const W = Math.max(MIN_W, Math.min(MAX_W, (room - (cols.length - 1) * MIN_GAP) / Math.max(1, cols.length)));
  const GAP = cols.length > 1 ? Math.max(MIN_GAP, Math.min(MAX_GAP, (room - cols.length * W) / (cols.length - 1))) : MIN_GAP;

  // Positions: each node level with what it's linked to (see graphlayout.ts).
  const opts = useMemo(() => ({ W, H, GAP, ROW, TOP, INDENT: 16 }), [W, GAP]);
  const layout = useMemo(() => layoutGraph(shown, cols, opts), [shown, cols, opts]);
  const curve = (a: string, b: string) => edgePath(layout, a, b, opts);
  // What's drawn: with more than a few hundred nodes, what's in view and a screen around
  // it (links whose ends' box reaches into that). Scrolling draws the rest as it comes.
  const MARGIN = 900;
  const culling = shown.nodes.length > 600;
  const near = (x1: number, y1: number, x2: number, y2: number) =>
    !culling || (x2 >= view.x - MARGIN && x1 <= view.x + view.w + MARGIN && y2 >= view.y - MARGIN && y1 <= view.y + view.h + MARGIN);
  const drawnNodes = shown.nodes.filter((n) => {
    const p = layout.pos.get(n.key)!;
    return near(p.x, p.y, p.x + p.w, p.y + H) || n.key === sel?.key;
  });
  const drawnEdges = shown.edges.filter((e) => {
    const p = layout.pos.get(e.from)!;
    const q = layout.pos.get(e.to)!;
    return near(Math.min(p.x, q.x), Math.min(p.y, q.y), Math.max(p.x, q.x) + W, Math.max(p.y, q.y) + H);
  });

  // How each node and link is drawn, on screen and in the saved picture alike.
  const nodeLook = (n: GNode) => {
    const isSel = sel?.key === n.key && mode === 'trace';
    return { dim: !lit(n.key), selected: isSel, onPath: mode === 'trace' && !!sel && !isSel && (up.has(n.key) || down.has(n.key)) };
  };
  const edgeLook = (e: { from: string; to: string; state?: string }) => {
    const on = lit(e.from) && lit(e.to);
    const hot = mode === 'trace' && !!sel && on && ((upPath(e.from) && upPath(e.to)) || (downPath(e.from) && downPath(e.to)));
    return { dim: !on, hot, suspect: e.state === 'suspect' };
  };

  const picture = (): GraphPicture => ({
    width: layout.width,
    height: layout.height,
    nodeW: W,
    nodeH: H,
    heads: cols.map((c, i) => ({ x: layout.colX[i], label: colLabel(c), count: c.nodes.length })),
    nodes: shown.nodes.map((n) => ({ ...layout.pos.get(n.key)!, node: n, ...nodeLook(n) })),
    edges: shown.edges.map((e) => ({ d: curve(e.from, e.to), ...edgeLook(e) })),
  });
  const fileName = `traceability-graph${hiding ? (sel && mode === 'trace' ? `-${sel.label.replace(/[^\w.-]+/g, '-')}` : '-gaps') : ''}`;
  const saveSvg = () => download(`${fileName}.svg`, graphSvg(picture()), 'image/svg+xml');
  const savePng = () =>
    svgToPng(graphSvg(picture()))
      .then((png) => download(`${fileName}.png`, png, 'image/png'))
      .catch((e: Error) => notify(`Couldn’t make the picture: ${e.message}`, 'error'));

  const pick = (key: string) => {
    setSelected(key);
    setMode('trace');
  };

  const componentKeys = useMemo(() => [...new Set([...index.config.components.map((c) => c.key), ...index.items.flatMap((i) => i.components)])].sort(), [index]);
  const jira = index.config.jiraUrl;

  return (
    <div className="dashboard graph-page">
      <div className="dash-head graph-head">
        <div>
          <h1>Traceability graph</h1>
          <p className="muted">Click any node to trace what it depends on and what depends on it.</p>
        </div>
        <div className="segmented small" role="tablist" aria-label="Mode">
          <button type="button" role="tab" aria-selected={mode === 'trace'} className={mode === 'trace' ? 'on' : ''} onClick={() => setMode('trace')}>
            Trace selection
          </button>
          <button type="button" role="tab" aria-selected={mode === 'gaps'} className={mode === 'gaps' ? 'on' : ''} onClick={() => setMode('gaps')}>
            Show gaps ({gaps.length})
          </button>
        </div>
      </div>

      <div className="graph-filters">
        <label className="field inline">
          <span>Component</span>
          <select value={component} onChange={(e) => setComponent(e.target.value)}>
            <option value="">All</option>
            {componentKeys.map((c) => (
              <option key={c} value={c}>
                {index.config.components.find((x) => x.key === c)?.name ?? c}
              </option>
            ))}
          </select>
        </label>
        <div className="search graph-search">
          <Icon name="search" />
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search REQ, test case, issue, component…" aria-label="Search nodes" />
        </div>
        <label className="field inline">
          <span>Commits</span>
          <select value={commitCount} onChange={(e) => setCommitCount(Number(e.target.value))} disabled={!project.code.repo}>
            <option value={0}>None</option>
            <option value={10}>Newest 10</option>
            <option value={30}>Newest 30</option>
            <option value={100}>Newest 100</option>
            <option value={5000}>All read ({project.commits.filter((c) => c.issues.length || c.items.length).length})</option>
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={hideObsolete} onChange={(e) => setHideObsolete(e.target.checked)} />
          <span>Hide obsolete</span>
        </label>
        {refining && (
          <label className="field inline" title="Requirements refining others: a column for each level, or all in one column, each under the one it refines">
            <span>Levels</span>
            <select value={levelsTogether ? 'together' : 'separate'} onChange={(e) => setLevelsTogether(e.target.value === 'together')}>
              <option value="separate">A column each</option>
              <option value="together">In one column</option>
            </select>
          </label>
        )}
        <label className="check" title="Leave out what isn't on the selected node's trace, or isn't a gap">
          <input type="checkbox" checked={hideFaded} onChange={(e) => setHideFaded(e.target.checked)} />
          <span>Hide what’s faded</span>
        </label>
        <span className="tool-spacer" />
        <div className="graph-save" role="group" aria-label="Save the graph as a picture">
          <span className="small muted">Save as</span>
          <button type="button" className="button small" onClick={saveSvg} disabled={!shown.nodes.length} title="The graph as shown, for documents (scales without blurring)">
            <Icon name="download" size={14} /> SVG
          </button>
          <button type="button" className="button small" onClick={() => void savePng()} disabled={!shown.nodes.length} title="The graph as shown, as an image">
            <Icon name="download" size={14} /> PNG
          </button>
        </div>
        <div className="zoom" role="group" aria-label="Zoom">
          <button type="button" className="icon-button" aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(0.4, +(z - 0.1).toFixed(2)))}>
            −
          </button>
          <span className="small muted">{Math.round(zoom * 100)}%</span>
          <button type="button" className="icon-button" aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(1.5, +(z + 0.1).toFixed(2)))}>
            +
          </button>
        </div>
      </div>

      <div className="dash-columns">
        <section className="card grow graph-card" aria-label="Graph">
          {shown.nodes.length === 0 ? (
            <p className="muted">{graph.nodes.length ? 'No gaps in what’s shown.' : 'Nothing matches.'}</p>
          ) : (
            <div className="graph-scroll" ref={scroller} onClick={(e) => e.target === e.currentTarget && setSelected(null)}>
              <div className="graph-canvas" style={{ width: layout.width, height: layout.height, zoom }} onClick={(e) => e.target === e.currentTarget && setSelected(null)}>
                <svg width={layout.width} height={layout.height} className="graph-edges" aria-hidden="true">
                  {drawnEdges.map((e) => {
                    const look = edgeLook(e);
                    return <path key={`${e.from}>${e.to}`} d={curve(e.from, e.to)} className={`edge${look.hot ? ' hot' : ''}${look.suspect ? ' suspect' : ''}${look.dim ? ' dim' : ''}`} />;
                  })}
                </svg>
                {cols.map((c, i) => (
                  <div key={`${c.type}${c.depth}${c.itemType ?? ''}`} className="graph-col-head" style={{ left: layout.colX[i], width: W }}>
                    <span className="strong">{colLabel(c)}</span> <span className="muted">{c.nodes.length}</span>
                  </div>
                ))}
                {drawnNodes.map((n) => {
                  const p = layout.pos.get(n.key)!;
                  const { dim, selected: isSel, onPath } = nodeLook(n);
                  return (
                    <button
                      key={n.key}
                      type="button"
                      className={`gnode ${n.type}${n.gap ? (n.warn ? ' warn' : ' gap') : ''}${n.status === 'obsolete' ? ' obsolete' : ''}${dim ? ' dim' : ''}${isSel ? ' selected' : ''}${onPath ? ' on-path' : ''}`}
                      style={{ left: p.x, top: p.y, width: p.w, height: H }}
                      aria-pressed={sel?.key === n.key}
                      onClick={() => pick(n.key)}
                      onDoubleClick={() => n.item && onOpenId(n.item.id)}
                      title={[n.gap, n.item ? 'Double-click to open.' : ''].filter(Boolean).join(' ') || undefined}
                    >
                      {n.tag && <span className="gnode-tag">{n.tag}</span>}
                      <span className="gnode-title">{n.label}</span>
                      <span className="gnode-sub">{n.sub}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {culling && !hiding && (
            <p className="small muted graph-hidden-note">
              A large graph: {shown.nodes.length.toLocaleString()} nodes. Narrow it with a component or a search, or select a node and tick <strong>Hide what’s faded</strong>{' '}
              to see just its trace.
            </p>
          )}
          {hiding && graph.nodes.length > 0 && (
            <p className="small muted graph-hidden-note">
              Showing {shown.nodes.length} of {graph.nodes.length} nodes: {mode === 'gaps' ? 'the gaps' : `${sel!.label}’s trace`}.{' '}
              <button type="button" className="link-button small" onClick={() => setHideFaded(false)}>
                Show all
              </button>
            </p>
          )}
          <div className="legend">
            <span>
              <i className="swatch commit" />
              Commit
            </span>
            <span>
              <i className="swatch issue" />
              Jira issue
            </span>
            <span>
              <i className="swatch req" />
              Requirement
            </span>
            <span>
              <i className="swatch plain" />
              Test case or component
            </span>
            {index.config.types.some((t) => !t.builtIn) && (
              <span>
                <i className="swatch item" />
                {index.config.types
                  .filter((t) => !t.builtIn)
                  .map((t) => t.name)
                  .join(', ')}
              </span>
            )}
            <span>
              <i className="swatch selected" />
              Selected
            </span>
            <span>
              <i className="swatch gap" />
              <span className="gnode-tag">No tests</span> Something missing
            </span>
            <span>
              <i className="swatch warn" />
              <span className="gnode-tag warn-tag">Suspect</span> Needs a look now
            </span>
          </div>
        </section>

        <aside className="card attention graph-side">
          {mode === 'gaps' ? (
            <>
              <h2>
                {gaps.length} gap{gaps.length === 1 ? '' : 's'}
              </h2>
              {gaps.length === 0 && <p className="muted">None in what’s shown.</p>}
              {gaps.map((g) => (
                <button key={g.key} type="button" className="gap-row" onClick={() => pick(g.key)}>
                  <span className="strong">
                    {g.label} · {g.type === 'component' ? 'component' : g.sub}
                  </span>
                  <span className={`small ${g.warn ? 'warn-text' : 'muted'}`}>{g.gap}</span>
                </button>
              ))}
            </>
          ) : sel ? (
            <>
              <div className="sel-head">
                <span className="kind-label">{sel.type === 'item' ? typeName(index.config, sel.itemType!) : TYPE_LABEL[sel.type]}</span>
                <h2>{sel.label}</h2>
                <span className="muted">{sel.sub}</span>
              </div>
              <div className="link-meta">
                {sel.status !== undefined && (sel.issue ? <span className={`pill cat-${sel.issue.statusCategory || 'new'}`}>{sel.status}</span> : <StatusPill status={sel.status} />)}
                {sel.issue && <span className="muted small">{[sel.issue.type, sel.issue.fixVersions.length ? `fix ${sel.issue.fixVersions.join(', ')}` : ''].filter(Boolean).join(' · ')}</span>}
                {sel.item && (
                  <button type="button" className="button small" onClick={() => onOpenId(sel.item!.id)}>
                    Open
                  </button>
                )}
                {traceTests.length > 0 && (
                  <button
                    type="button"
                    className="button small"
                    onClick={() => addToWork(project, traceTests.map((t) => ({ id: t.id, reason: `In the trace of ${sel.label}` })))}
                    title="The tests in its trace: upstream and downstream"
                  >
                    <Icon name="plus" size={14} /> Add {traceTests.length} test{traceTests.length === 1 ? '' : 's'} to work list
                  </button>
                )}
                {sel.type === 'issue' && jira && (
                  <a className="button small" href={`${jira}/browse/${encodeURIComponent(sel.label)}`} target="_blank" rel="noreferrer">
                    <Icon name="external" size={14} /> Jira
                  </a>
                )}
              </div>
              {sel.commit && <CommitDetails c={sel.commit} componentName={(k) => index.config.components.find((x) => x.key === k)?.name ?? k} />}
              <p className={`sel-status ${sel.gap ? (sel.warn ? 'warn' : 'gap') : 'ok'}`}>{sel.gap ?? statusText(sel, graph.fwd.get(sel.key) ?? [], graph.back.get(sel.key) ?? [])}</p>
              <div className="counts">
                <div>
                  <span className="small muted">Upstream</span>
                  <span className="count-value">{up.size}</span>
                </div>
                <div>
                  <span className="small muted">Downstream</span>
                  <span className="count-value">{down.size}</span>
                </div>
              </div>
              <div className="stack">
                <span className="strong">Directly linked</span>
                {[...(graph.back.get(sel.key) ?? []).map((k) => ({ k, dir: 'up' })), ...(graph.fwd.get(sel.key) ?? []).map((k) => ({ k, dir: 'down' }))].map(({ k, dir }) => {
                  const n = graph.byKey.get(k)!;
                  const edge = graph.edges.find((e) => (dir === 'up' ? e.from === k && e.to === sel.key : e.from === sel.key && e.to === k));
                  return (
                    <button key={k} type="button" className="neighbour" onClick={() => pick(k)}>
                      <span className="mono small">
                        {edge?.state === 'suspect' && <Icon name="warn" size={12} />} {n.label}
                      </span>
                      <span className="muted small">
                        {dir === 'up' ? `← ${word(n)}` : `${word(n)} →`}
                        {edge?.sources && ` · ${edge.sources.map((x) => SOURCE_LABEL[x]).join(', ')}`}
                      </span>
                    </button>
                  );
                })}
                {!graph.back.get(sel.key) && !graph.fwd.get(sel.key) && <span className="warn-text small">Nothing linked yet.</span>}
              </div>
            </>
          ) : (
            <>
              <h2>Nothing selected</h2>
              <p className="muted">Click a node to see everything it traces to. Double-click a requirement or test case to open it.</p>
              <p className="muted small">
                {graph.nodes.length} nodes, {graph.edges.length} links shown.
              </p>
            </>
          )}
        </aside>
      </div>
      {!project.code.repo && (
        <p className="muted small">No commits: connect the code repository under Settings to see which commits reach each requirement through its Jira issues.</p>
      )}
      <p className="muted small">
        Links: Jira keys in commit messages · <code>jira:</code> on requirements → requirements · <code>verifies:</code> on test cases · test cases tagged with <code>components:</code> · component paths
        in trace.yml.
      </p>
    </div>
  );
}

function CommitDetails({ c, componentName }: { c: LinkedCommit; componentName: (key: string) => string }) {
  return (
    <div className="commit-details small">
      <span>
        {c.commit.author} · {new Date(c.commit.date).toLocaleString()}
      </span>
      {c.commit.body && <span className="muted commit-body">{c.commit.body}</span>}
      <span className="muted">
        {c.commit.files.length} file{c.commit.files.length === 1 ? '' : 's'} changed
        {c.components.length ? `, in ${c.components.map(componentName).join(', ')}` : ', in no configured component'}
      </span>
    </div>
  );
}

function statusText(n: GNode, down: string[], up: string[]): string {
  const downstream = down.length;
  const upstream = up.length;
  if (n.type === 'req') {
    const tests = down.filter((k) => k.startsWith('test:')).length;
    const refined = down.filter((k) => k.startsWith('req:')).length;
    const it = n.item;
    if (!tests && it && byEvidence(it.verification) && it.evidence.length) return `Verified by ${it.verification}: ${it.evidence.join(', ')}.`;
    if (!tests && !refined && it?.verification === 'none') return 'Needs no verification.';
    if (!tests && refined) return `Covered through the ${refined} requirement${refined === 1 ? '' : 's'} refining it.`;
    return `Verified by ${tests} test case${tests === 1 ? '' : 's'}${refined ? `; refined by ${refined} requirement${refined === 1 ? '' : 's'}` : ''}.`;
  }
  if (n.type === 'commit') return `Names ${downstream} issue${downstream === 1 ? '' : 's'} or item${downstream === 1 ? '' : 's'}.`;
  if (n.type === 'test') return `Verifies ${upstream} requirement${upstream === 1 ? '' : 's'}.`;
  if (n.type === 'item') return downstream + upstream ? `Linked with ${downstream + upstream} item${downstream + upstream === 1 ? '' : 's'}.` : 'Nothing is linked to it yet.';
  if (n.type === 'issue') return `Linked to ${downstream} requirement${downstream === 1 ? '' : 's'} or test case${downstream === 1 ? '' : 's'}.`;
  return `Covered by ${upstream} test case${upstream === 1 ? '' : 's'}.`;
}

// A PNG of an SVG picture, at twice its size so it stays sharp on a slide.
function svgToPng(svg: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = 2;
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth * scale;
      canvas.height = img.naturalHeight * scale;
      const ctx = canvas.getContext('2d');
      if (!ctx) return reject(new Error('no canvas'));
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('it is too large'))), 'image/png');
    };
    img.onerror = () => reject(new Error('the drawing could not be read'));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}
