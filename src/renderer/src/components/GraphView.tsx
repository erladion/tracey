// The traceability graph: issues → requirements → test cases → components. Click a
// node to trace everything upstream and downstream of it; "Show gaps" lights up what's
// missing or needs a look.
import { useEffect, useMemo, useRef, useState } from 'react';
import { buildGraph, columns, walk, type GNode, type NodeType } from '../../../core/graph';
import type { LinkedCommit } from '../../../core/commits';
import { SOURCE_LABEL } from '../../../core/links';
import type { Project } from '../project';
import { Icon } from '../icons';
import { StatusPill } from './bits';
import { load, save } from '../storage';

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

const LABELS: Record<NodeType, string> = { commit: 'Commits', issue: 'Jira issues', req: 'Requirements', test: 'Test cases', component: 'Components' };
const TYPE_LABEL: Record<NodeType, string> = { commit: 'Commit', issue: 'Jira issue', req: 'Requirement', test: 'Test case', component: 'Component' };
const REL: Record<NodeType, string> = { commit: 'commit', issue: 'issue', req: 'requirement', test: 'test case', component: 'component' };

export function GraphView({ project, focus, onOpenId }: Props) {
  const { index } = project;
  const [mode, setMode] = useState<'trace' | 'gaps'>('trace');
  const [selected, setSelected] = useState<string | null>(focus);
  const [component, setComponent] = useState('');
  const [query, setQuery] = useState('');
  const [hideObsolete, setHideObsolete] = useState(true);
  const [commitCount, setCommitCount] = useState(() => load<number>('trace.graphCommits') ?? 30);
  useEffect(() => save('trace.graphCommits', commitCount), [commitCount]);
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
  const cols = useMemo(() => columns(graph).filter((c) => c.nodes.length > 0), [graph]);

  // Spread the columns over the width there is; scroll (or zoom out) when it's not enough.
  const scroller = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState(1000);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAvail(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [graph.nodes.length > 0]);
  const room = avail / zoom - 16; // a little room for the selection ring and a scrollbar
  const W = Math.max(MIN_W, Math.min(MAX_W, (room - (cols.length - 1) * MIN_GAP) / Math.max(1, cols.length)));
  const GAP = cols.length > 1 ? Math.max(MIN_GAP, Math.min(MAX_GAP, (room - cols.length * W) / (cols.length - 1))) : MIN_GAP;

  // Positions: columns left to right, each centred on the tallest.
  const layout = useMemo(() => {
    const maxRows = Math.max(1, ...cols.map((c) => c.nodes.length));
    const pos = new Map<string, { x: number; y: number }>();
    cols.forEach((c, ci) => {
      const offset = TOP + ((maxRows - c.nodes.length) * ROW) / 2;
      c.nodes.forEach((n, i) => pos.set(n.key, { x: ci * (W + GAP), y: offset + i * ROW }));
    });
    return { pos, width: Math.max(W, cols.length * (W + GAP) - GAP), height: TOP + maxRows * ROW };
  }, [cols, GAP, W]);

  const sel = selected && graph.byKey.has(selected) ? graph.byKey.get(selected)! : null;
  const up = useMemo(() => (sel ? walk(sel.key, graph.back) : new Set<string>()), [sel, graph]);
  const down = useMemo(() => (sel ? walk(sel.key, graph.fwd) : new Set<string>()), [sel, graph]);
  const gaps = graph.nodes.filter((n) => n.gap);

  const lit = (key: string) => (mode === 'gaps' ? !!graph.byKey.get(key)?.gap : !sel || key === sel.key || up.has(key) || down.has(key));
  const upPath = (k: string) => k === sel?.key || up.has(k);
  const downPath = (k: string) => k === sel?.key || down.has(k);

  const curve = (a: string, b: string) => {
    const p = layout.pos.get(a)!;
    const q = layout.pos.get(b)!;
    const x1 = p.x + W;
    const y1 = p.y + H / 2;
    const x2 = q.x;
    const y2 = q.y + H / 2;
    return `M ${x1} ${y1} C ${x1 + GAP / 2} ${y1}, ${x2 - GAP / 2} ${y2}, ${x2} ${y2}`;
  };

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
        <span className="tool-spacer" />
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
          {graph.nodes.length === 0 ? (
            <p className="muted">Nothing matches.</p>
          ) : (
            <div className="graph-scroll" ref={scroller} onClick={(e) => e.target === e.currentTarget && setSelected(null)}>
              <div className="graph-canvas" style={{ width: layout.width, height: layout.height, zoom }} onClick={(e) => e.target === e.currentTarget && setSelected(null)}>
                <svg width={layout.width} height={layout.height} className="graph-edges" aria-hidden="true">
                  {graph.edges.map((e) => {
                    const on = lit(e.from) && lit(e.to);
                    const hot = mode === 'trace' && !!sel && on && ((upPath(e.from) && upPath(e.to)) || (downPath(e.from) && downPath(e.to)));
                    return (
                      <path
                        key={`${e.from}>${e.to}`}
                        d={curve(e.from, e.to)}
                        className={`edge${hot ? ' hot' : ''}${e.state === 'suspect' ? ' suspect' : ''}${on ? '' : ' dim'}`}
                      />
                    );
                  })}
                </svg>
                {cols.map((c) => (
                  <div key={c.type} className="graph-col-head" style={{ left: layout.pos.get(c.nodes[0].key)!.x, width: W }}>
                    <span className="strong">{LABELS[c.type]}</span> <span className="muted">{c.nodes.length}</span>
                  </div>
                ))}
                {graph.nodes.map((n) => {
                  const p = layout.pos.get(n.key)!;
                  return (
                    <button
                      key={n.key}
                      type="button"
                      className={`gnode ${n.type}${n.gap ? (n.warn ? ' warn' : ' gap') : ''}${n.status === 'obsolete' ? ' obsolete' : ''}${lit(n.key) ? '' : ' dim'}${sel?.key === n.key && mode === 'trace' ? ' selected' : ''}`}
                      style={{ left: p.x, top: p.y, width: W, height: H }}
                      aria-pressed={sel?.key === n.key}
                      onClick={() => pick(n.key)}
                      onDoubleClick={() => n.item && onOpenId(n.item.id)}
                      title={n.item ? 'Double-click to open' : undefined}
                    >
                      <span className="gnode-title">{n.label}</span>
                      <span className="gnode-sub">{n.sub}</span>
                    </button>
                  );
                })}
              </div>
            </div>
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
            <span>
              <i className="swatch warn" />
              Suspect or broken link
            </span>
            <span>
              <i className="swatch gap" />
              Gap (no tests)
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
                <span className="kind-label">{TYPE_LABEL[sel.type]}</span>
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
                {sel.type === 'issue' && jira && (
                  <a className="button small" href={`${jira}/browse/${encodeURIComponent(sel.label)}`} target="_blank" rel="noreferrer">
                    <Icon name="external" size={14} /> Jira
                  </a>
                )}
              </div>
              {sel.commit && <CommitDetails c={sel.commit} componentName={(k) => index.config.components.find((x) => x.key === k)?.name ?? k} />}
              <p className={`sel-status ${sel.gap ? (sel.warn ? 'warn' : 'gap') : 'ok'}`}>{sel.gap ?? statusText(sel, graph.fwd.get(sel.key)?.length ?? 0, graph.back.get(sel.key)?.length ?? 0)}</p>
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
                        {dir === 'up' ? `← ${REL[n.type]}` : `${REL[n.type]} →`}
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

function statusText(n: GNode, downstream: number, upstream: number): string {
  if (n.type === 'commit') return `Names ${downstream} issue${downstream === 1 ? '' : 's'} or item${downstream === 1 ? '' : 's'}.`;
  if (n.type === 'req') return `Verified by ${downstream} test case${downstream === 1 ? '' : 's'}.`;
  if (n.type === 'test') return `Verifies ${upstream} requirement${upstream === 1 ? '' : 's'}.`;
  if (n.type === 'issue') return `Linked to ${downstream} requirement${downstream === 1 ? '' : 's'} or test case${downstream === 1 ? '' : 's'}.`;
  return `Covered by ${upstream} test case${upstream === 1 ? '' : 's'}.`;
}
