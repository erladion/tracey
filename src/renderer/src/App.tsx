import { useCallback, useEffect, useState } from 'react';
import type { RepoEntry } from '../../shared/api';
import type { Kind } from '../../core/config';
import { api } from './api';
import { useProject } from './project';
import { Icon } from './icons';
import { Toasts } from './components/Toasts';
import { StartScreen } from './components/StartScreen';
import { Sidebar } from './components/Sidebar';
import { ItemView } from './components/ItemView';
import { CoverageView } from './components/CoverageView';
import { SettingsView } from './components/SettingsView';
import { GraphView } from './components/GraphView';
import { RunsView, type RunFocus } from './components/RunsView';
import { GitBar } from './components/GitBar';
import { NewItemDialog, type NewItemRequest } from './components/NewItemDialog';
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
  const project = useProject(repo);
  const { index } = project;
  const selKey = `trace.selected.${repo.id}`;
  const [view, setView] = useState<View>('items');
  const [kind, setKind] = useState<Kind>('requirement');
  const [selected, setSelectedState] = useState<string | null>(() => load<string>(selKey));
  const [newItem, setNewItem] = useState<NewItemRequest | null>(null);
  const [graphFocus, setGraphFocus] = useState<string | null>(null);
  const [runFocus, setRunFocus] = useState<RunFocus | null>(null);

  const select = useCallback(
    (path: string | null) => {
      setSelectedState(path);
      save(selKey, path);
    },
    [selKey],
  );

  const openId = useCallback(
    (id: string) => {
      const item = index.byId.get(id);
      if (!item) return notify(`There's no ${id}.`, 'error');
      select(item.path);
      setKind(item.kind);
      setView('items');
    },
    [index, select],
  );

  const openPath = useCallback(
    (path: string) => {
      const item = index.byPath.get(path);
      if (item) setKind(item.kind);
      select(path);
      setView('items');
    },
    [index, select],
  );

  // Ctrl+S saves now; it saves by itself anyway.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void project.flush();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [project]);

  const hasText = selected != null && project.texts.has(selected);

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-left">
          <button type="button" className="brand" onClick={onClose} title="Repositories">
            <span className="brand-mark">
              <Icon name="logo" size={20} />
            </span>
            <span className="brand-name">Trace</span>
          </button>
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
                {v === 'coverage' && index.problems.some((p) => p.severity === 'error') && <span className="tab-dot" aria-label="has errors" />}
              </button>
            ))}
          </nav>
        </div>
        <div className="topbar-right">
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
            <Sidebar project={project} kind={kind} onKind={setKind} selected={selected} onSelect={select} onNew={() => setNewItem({ kind })} />
            <main className="main">
              {hasText ? (
                <ItemView
                  key={selected!}
                  project={project}
                  path={selected!}
                  onOpenId={openId}
                  onNewTest={(req) => setNewItem({ kind: 'testcase', verifies: [req.id], components: req.components })}
                  onShowInGraph={(it) => {
                    setGraphFocus(`${it.kind === 'requirement' ? 'req' : 'test'}:${it.id}`);
                    setView('graph');
                  }}
                  onOpenRun={(f) => {
                    setRunFocus(f);
                    setView('runs');
                  }}
                  onDeleted={() => select(null)}
                />
              ) : (
                <div className="empty-state">
                  {project.loading ? (
                    <p>Loading…</p>
                  ) : index.items.length ? (
                    <p>Choose a {kind === 'requirement' ? 'requirement' : 'test case'} on the left.</p>
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
          <CoverageView project={project} onOpenId={openId} onOpenPath={openPath} />
        ) : view === 'runs' ? (
          <RunsView key={runFocus ? `${runFocus.path}:${runFocus.caseId}` : ''} project={project} focus={runFocus} onOpenId={openId} />
        ) : view === 'graph' ? (
          <GraphView project={project} focus={graphFocus} onOpenId={openId} />
        ) : (
          <SettingsView project={project} />
        )}
      </div>

      <GitBar project={project} />

      {newItem && (
        <NewItemDialog
          request={newItem}
          index={index}
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
