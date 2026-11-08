import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RepoEntry } from '../../shared/api';
import { typeWord, type Kind } from '../../core/config';
import { nodeKey } from '../../core/graph';
import { api } from './api';
import { useProject, type Project } from './project';
import { coverage, forVariant } from '../../core/model';
import { issueCounts } from './components/Issues';
import { Icon } from './icons';
import { Toasts } from './components/Toasts';
import { StartScreen } from './components/StartScreen';
import { Sidebar } from './components/Sidebar';
import { ItemView } from './components/ItemView';
import { BulkEdit } from './components/BulkEdit';
import { CoverageView } from './components/CoverageView';
import { SettingsView } from './components/SettingsView';
import { GraphView } from './components/GraphView';
import { RunsView, type RunFocus } from './components/RunsView';
import { GitBar } from './components/GitBar';
import { NewItemDialog, type NewItemRequest } from './components/NewItemDialog';
import { WorkListDialog } from './components/WorkList';
import { Palette, type PaletteAction } from './components/Palette';
import { notify } from './notify';
import { load, save } from './storage';

const LAST_REPO = 'trace.lastRepo';

export function App() {
  const [repo, setRepo] = useState<RepoEntry | null>(null);
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    const last = load<string>(LAST_REPO);
    if (!last) return setBooting(false);
    api
      .openRepo(last)
      .then(setRepo)
      .catch(() => save(LAST_REPO, null))
      .finally(() => setBooting(false));
  }, []);

  const open = useCallback((r: RepoEntry) => {
    save(LAST_REPO, r.id);
    setRepo(r);
  }, []);

  return (
    <>
      {booting ? null : repo ? (
        <Workspace
          key={repo.id}
          repo={repo}
          onClose={() => {
            save(LAST_REPO, null);
            setRepo(null);
          }}
        />
      ) : (
        <StartScreen onOpen={open} />
      )}
      <Toasts />
    </>
  );
}

type View = 'items' | 'coverage' | 'graph' | 'runs' | 'settings';

function Workspace({ repo, onClose }: { repo: RepoEntry; onClose: () => void }) {
  const full = useProject(repo);
  // The product variant being looked at: the views show what applies to it.
  const variantKey = `trace.variant.${repo.id}`;
  const [variantChoice, setVariantChoice] = useState<string | null>(() => load<string>(variantKey));
  const variants = full.index.config.variants;
  const variant = variantChoice && variants.some((v) => v.key === variantChoice) ? variantChoice : null;
  const chooseVariant = (v: string | null) => {
    setVariantChoice(v);
    save(variantKey, v);
  };
  const variantIndex = useMemo(() => (variant ? forVariant(full.index, variant) : full.index), [full.index, variant]);
  const variantRuns = useMemo(() => (variant ? full.runs.filter((r) => !r.variant || r.variant === variant) : full.runs), [full.runs, variant]);
  const project: Project = variant ? { ...full, index: variantIndex, runs: variantRuns, variant } : full;
  const { index } = project;
  const selKey = `trace.selected.${repo.id}`;
  const [view, setView] = useState<View>('items');
  const [kind, setKind] = useState<Kind>('requirement');
  const [selected, setSelectedState] = useState<string | null>(() => load<string>(selKey));
  const [newItem, setNewItem] = useState<NewItemRequest | null>(null);
  const [picked, setPicked] = useState<string[]>([]); // several items, to change at once
  useEffect(() => setPicked([]), [kind, repo.id]);
  const [graphFocus, setGraphFocus] = useState<string | null>(null);
  const [runFocus, setRunFocus] = useState<RunFocus | null>(null);
  const [workOpen, setWorkOpen] = useState(false);
  // A test run to start once Test runs shows: from the work list, or a new one.
  const [newRun, setNewRun] = useState<'work' | 'any' | null>(null);

  const select = useCallback(
    (path: string | null) => {
      setSelectedState(path);
      save(selKey, path);
    },
    [selKey],
  );

  const openId = useCallback(
    (id: string) => {
      const item = full.index.byId.get(id); // any variant's
      if (!item) return notify(`There's no ${id}.`, 'error');
      select(item.path);
      setKind(item.kind);
      setView('items');
    },
    [full.index, select],
  );

  const openPath = useCallback(
    (path: string) => {
      const item = full.index.byPath.get(path);
      if (item) setKind(item.kind);
      select(path);
      setView('items');
    },
    [full.index, select],
  );

  // What needs a look, for the status bar and the Coverage tab: the whole project's.
  const issuesCov = useMemo(() => coverage(full.index), [full.index]);
  const issues = issueCounts(issuesCov);

  // ---- back and forward: the places visited (a view, and the item open in it) ----
  type Place = { view: View; path: string | null };
  const hist = useRef<{ list: Place[]; at: number }>({ list: [], at: -1 });
  const moving = useRef(false);
  const [, bumpHist] = useState(0);
  useEffect(() => {
    if (moving.current) {
      moving.current = false;
      return;
    }
    const place: Place = { view, path: view === 'items' ? selected : null };
    const h = hist.current;
    const cur = h.list[h.at];
    if (cur && cur.view === place.view && cur.path === place.path) return;
    h.list = [...h.list.slice(0, h.at + 1), place].slice(-100);
    h.at = h.list.length - 1;
    bumpHist((n) => n + 1);
  }, [view, selected]);
  const canGo = (d: number) => hist.current.at + d >= 0 && hist.current.at + d < hist.current.list.length;
  const go = useCallback(
    (d: number) => {
      const h = hist.current;
      const to = h.list[h.at + d];
      if (!to) return;
      h.at += d;
      moving.current = true;
      if (to.path) {
        const it = full.index.byPath.get(to.path);
        if (it) setKind(it.kind);
        select(to.path);
      }
      setView(to.view);
      setRunFocus(null);
      bumpHist((n) => n + 1);
    },
    [full.index, select],
  );
  // Items opened lately, newest first: for the palette.
  const recent = [...new Set([...hist.current.list].reverse().flatMap((p) => (p.path ? [p.path] : [])))];

  const [paletteOpen, setPaletteOpen] = useState(false);

  // Ctrl+S saves now (it saves by itself anyway); Ctrl+Shift+P goes to anything; Alt+←/→
  // and the mouse's back and forward buttons go back and forward.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void project.flush();
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        setPaletteOpen(true);
      } else if (e.altKey && !mod && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        go(e.key === 'ArrowLeft' ? -1 : 1);
      }
    };
    const mouse = (e: MouseEvent) => {
      if (e.button === 3 || e.button === 4) {
        e.preventDefault();
        go(e.button === 3 ? -1 : 1);
      }
    };
    window.addEventListener('keydown', key);
    window.addEventListener('mouseup', mouse);
    return () => {
      window.removeEventListener('keydown', key);
      window.removeEventListener('mouseup', mouse);
    };
  }, [project, go]);

  const paletteActions: PaletteAction[] = [
    { label: 'Go to Requirements & tests', run: () => setView('items') },
    { label: 'Go to Coverage', run: () => setView('coverage') },
    { label: 'Go to Traceability graph', run: () => setView('graph') },
    { label: 'Go to Test runs', run: () => setView('runs') },
    { label: 'Go to Settings', run: () => setView('settings') },
    { label: 'Open the work list', hint: `${project.work.length} tests`, run: () => setWorkOpen(true) },
    {
      label: 'New test run',
      run: () => {
        setRunFocus(null);
        setView('runs');
        setNewRun('any');
      },
    },
    ...index.config.types.map((t) => ({ label: `New ${t.name.toLowerCase()}`, run: () => setNewItem({ kind: t.key }) })),
  ];

  const hasText = selected != null && project.texts.has(selected);

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-left">
          <button type="button" className="brand" onClick={onClose} title="Repositories">
            <span className="brand-mark">
              <Icon name="logo" size={20} />
            </span>
            <span className="brand-name">Tracey</span>
          </button>
          <span className="nav-arrows">
            <button type="button" className="icon-button" onClick={() => go(-1)} disabled={!canGo(-1)} aria-label="Back" title="Back (Alt+←)">
              ←
            </button>
            <button type="button" className="icon-button" onClick={() => go(1)} disabled={!canGo(1)} aria-label="Forward" title="Forward (Alt+→)">
              →
            </button>
          </span>
          <span className="repo-name" title={repo.location}>
            {repo.name}
          </span>
          <nav className="views" aria-label="Views">
            {(
              [
                ['items', 'Requirements & tests'],
                ['coverage', 'Coverage'],
                ['graph', 'Traceability graph'],
                ['runs', 'Test runs'],
                ['settings', 'Settings'],
              ] as const
            ).map(([v, label]) => (
              <button key={v} type="button" className={`view-tab${view === v ? ' current' : ''}`} aria-current={view === v ? 'page' : undefined} onClick={() => {
                  setView(v);
                  setRunFocus(null);
                }}>
                {label}
                {v === 'coverage' &&
                  (issues.errors ? <span className="tab-dot" title="Errors" aria-label="has errors" /> : issues.review ? <span className="tab-dot review" title="Links to review" aria-label="has links to review" /> : null)}
              </button>
            ))}
          </nav>
        </div>
        <div className="topbar-right">
          {variants.length > 0 && (
            <label className="variant-pick" title="Show what applies to one product variant">
              <span className="muted small">Variant</span>
              <select value={variant ?? ''} onChange={(e) => chooseVariant(e.target.value || null)}>
                <option value="">All</option>
                {variants.map((v) => (
                  <option key={v.key} value={v.key}>
                    {v.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button type="button" className={`button work-button${project.work.length ? ' has' : ''}`} onClick={() => setWorkOpen(true)} title="Tests collected to run">
            Work list <span className="count">{project.work.length}</span>
          </button>
          <button type="button" className="button primary" onClick={() => setNewItem({ kind })}>
            <Icon name="plus" /> New
          </button>
          <ThemeButton />
        </div>
      </header>

      <div className="body">
        {project.error ? (
          <div className="empty-state">
            <h2>Couldn’t open {repo.name}</h2>
            <p>{project.error}</p>
            <button type="button" className="button" onClick={onClose}>
              Back to repositories
            </button>
          </div>
        ) : view === 'items' ? (
          <>
            <Sidebar project={project} kind={kind} onKind={setKind} selected={selected} onSelect={select} onNew={() => setNewItem({ kind })} picked={picked} onPick={setPicked} />
            <main className="main">
              {picked.length > 0 ? (
                <BulkEdit
                  project={full}
                  paths={picked}
                  onClear={() => setPicked([])}
                  onOpen={(path) => {
                    setPicked([]);
                    select(path);
                  }}
                />
              ) : hasText ? (
                <ItemView
                  key={selected!}
                  project={full}
                  path={selected!}
                  onOpenId={openId}
                  onNewTest={(req) => setNewItem({ kind: 'testcase', verifies: [req.id], components: req.components, variants: req.variants })}
                  onNewRefinement={(req) => setNewItem({ kind: 'requirement', refines: [req.id], components: req.components, variants: req.variants })}
                  onNewLinked={(k, link, target) =>
                    setNewItem({ kind: k, ...(link === 'verifies' ? { verifies: [target.id] } : { links: { [link]: [target.id] } }), components: target.components, variants: target.variants })
                  }
                  onShowInGraph={(it) => {
                    setGraphFocus(nodeKey(it));
                    setView('graph');
                  }}
                  onOpenRun={(f) => {
                    setRunFocus(f);
                    setView('runs');
                  }}
                  onDeleted={() => select(null)}
                  onRenamed={(p) => select(p)}
                />
              ) : (
                <div className="empty-state">
                  {project.loading ? (
                    <p>Loading…</p>
                  ) : index.items.length ? (
                    <p>Choose a {typeWord(index.config, kind)} on the left.</p>
                  ) : (
                    <>
                      <h2>No requirements or test cases yet</h2>
                      <p>
                        Items are Markdown files with an <code>id</code> in their front matter, in <code>{index.config.requirements.dir}/</code> and{' '}
                        <code>{index.config.testcases.dir}/</code>.
                      </p>
                      <button type="button" className="button primary" onClick={() => setNewItem({ kind: 'requirement' })}>
                        <Icon name="plus" /> New requirement
                      </button>
                    </>
                  )}
                </div>
              )}
            </main>
          </>
        ) : view === 'coverage' ? (
          <CoverageView project={project} onOpenId={openId} onOpenPath={openPath} onVariant={chooseVariant} />
        ) : view === 'runs' ? (
          <RunsView key={runFocus ? `${runFocus.path}:${runFocus.caseId}` : ''} project={project} focus={runFocus} onOpenId={openId} newRun={newRun} onNewRunShown={() => setNewRun(null)} />
        ) : view === 'graph' ? (
          <GraphView project={project} focus={graphFocus} onOpenId={openId} />
        ) : (
          <SettingsView project={full} />
        )}
      </div>

      <GitBar project={full} cov={issuesCov} onOpenId={openId} onOpenPath={openPath} onSettings={() => setView('settings')} />

      {paletteOpen && (
        <Palette
          project={project}
          actions={paletteActions}
          recent={recent}
          onOpenItem={(it) => openPath(it.path)}
          onOpenRun={(path) => {
            setRunFocus({ path, caseId: '' });
            setView('runs');
          }}
          onClose={() => setPaletteOpen(false)}
        />
      )}
      {workOpen && (
        <WorkListDialog
          project={project}
          onOpenId={openId}
          onClose={() => setWorkOpen(false)}
          onNewRun={() => {
            setWorkOpen(false);
            setRunFocus(null);
            setView('runs');
            setNewRun('work');
          }}
        />
      )}
      {newItem && (
        <NewItemDialog
          request={newItem}
          index={full.index}
          onClose={() => setNewItem(null)}
          onCreate={async (k, title, opts) => {
            try {
              const path = await project.createItem(k, title, opts);
              setNewItem(null);
              setKind(k);
              select(path);
              setView('items');
            } catch (e) {
              notify((e as Error).message, 'error');
            }
          }}
        />
      )}
    </div>
  );
}

function ThemeButton() {
  const [theme, setTheme] = useState<'light' | 'dark' | null>(() => load('trace.theme'));
  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
    save('trace.theme', theme);
  }, [theme]);
  const dark = theme ? theme === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  return (
    <button type="button" className="icon-button" onClick={() => setTheme(dark ? 'light' : 'dark')} aria-label={dark ? 'Light theme' : 'Dark theme'} title={dark ? 'Light theme' : 'Dark theme'}>
      <Icon name={dark ? 'sun' : 'moon'} />
    </button>
  );
}
