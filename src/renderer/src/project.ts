// The open repository: its files as they are now (edits included), what's derived
// from them, saving, and git status.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Commit, GitStatus, JiraIssue, JiraServer, JiraStatus, RepoEntry } from '../../shared/api';
import { buildIssueLinks, linkQuery, type IssueLinks } from '../../core/links';
import { parseConfig, typeOf } from '../../core/config';
import { linkCommits, type LinkedCommit } from '../../core/commits';
import { readRun, type TestRun } from '../../core/runs';
import { load, save } from './storage';
import type { Kind } from '../../core/config';
import { buildIndex, checkNewId, fingerprint, newItemPath, newItemText, nextId, type Item, type ProjectIndex } from '../../core/model';
import { decodeText, encodeText, joinFrontMatter, setFields, splitFrontMatter } from '../../core/frontmatter';
import { api } from './api';
import { notify } from './notify';

const SAVE_DELAY = 700;

export interface Project {
  repo: RepoEntry;
  loading: boolean;
  error: string | null;
  config: string | null;
  texts: Map<string, string>;
  index: ProjectIndex; // as the chosen variant sees it (allIndex when none is chosen)
  allIndex: ProjectIndex; // every item
  variant: string | null; // the product variant being looked at; null: all
  git: GitStatus | null;
  saving: boolean;
  // The code repository, whose commits name Jira issues.
  code: CodeState;
  commits: LinkedCommit[];
  setCodeRepo(entry: RepoEntry | null): void;
  // Jira: issues read for links, and the links from every source.
  jira: JiraState;
  links: IssueLinks;
  refreshJira(): Promise<void>;
  searchJira(jql: string): Promise<JiraIssue[]>; // and remember what's found
  reloadCommits(): Promise<void>;
  reload(): Promise<void>;
  setText(path: string, text: string): void;
  updateFields(path: string, changes: Record<string, unknown>): void;
  markReviewed(test: Item, reqIds: string[]): void;
  writeConfig(text: string): Promise<void>;
  createItem(kind: Kind, title: string, opts?: { id?: string; verifies?: string[]; refines?: string[]; links?: Record<string, string[]>; components?: string[]; variants?: string[] }): Promise<string>;
  deleteItem(path: string): Promise<void>; // any file: items and test runs
  runs: TestRun[];
  createFile(path: string, text: string): Promise<void>;
  updateFile(path: string, change: (text: string) => string): void;
  flush(): Promise<void>;
  refreshGit(): Promise<void>;
}

export interface CodeState {
  repo: RepoEntry | null; // where commits are read from
  how: 'chosen' | 'found' | 'none'; // picked by this user, found by its remote, or not connected
  loading: boolean;
  error: string | null;
  count: number; // commits read
}

export interface JiraState {
  server: JiraServer | null; // null: no jira.url in trace.yml
  status: JiraStatus | null;
  issues: JiraIssue[];
  loading: boolean;
  error: string | null;
  read: number; // issues read in the last refresh
  missing: string[]; // keys that don't exist in Jira
}

export function useProject(repo: RepoEntry): Project {
  const [texts, setTexts] = useState<Map<string, string>>(new Map());
  const [config, setConfig] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [git, setGit] = useState<GitStatus | null>(null);
  const [saving, setSaving] = useState(false);

  const textsRef = useRef(texts);
  textsRef.current = texts;
  const pending = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const inFlight = useRef(new Set<Promise<unknown>>());

  const refreshGit = useCallback(async () => {
    try {
      setGit(await api.gitStatus(repo.id));
    } catch {
      setGit(null);
    }
  }, [repo.id]);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const { config, files } = await api.loadFiles(repo.id);
      setConfig(config);
      setTexts(new Map(files.map((f) => [f.path, f.text])));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
    void refreshGit();
  }, [repo.id, refreshGit]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const write = useCallback(
    (path: string) => {
      pending.current.delete(path);
      const text = textsRef.current.get(path);
      if (text == null) return;
      setSaving(true);
      const p = api
        .writeFile(repo.id, path, text)
        .catch((e) => notify(`Couldn't save ${path}: ${(e as Error).message}`, 'error'))
        .finally(() => {
          inFlight.current.delete(p);
          if (!inFlight.current.size && !pending.current.size) setSaving(false);
          void refreshGit();
        });
      inFlight.current.add(p);
    },
    [repo.id, refreshGit],
  );

  const schedule = useCallback(
    (path: string) => {
      clearTimeout(pending.current.get(path));
      pending.current.set(
        path,
        setTimeout(() => write(path), SAVE_DELAY),
      );
      setSaving(true);
    },
    [write],
  );

  const flush = useCallback(async () => {
    for (const [path, t] of [...pending.current]) {
      clearTimeout(t);
      write(path);
    }
    await Promise.all([...inFlight.current]);
  }, [write]);

  // Save before the window closes.
  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => {
      if (pending.current.size) {
        void flush();
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', before);
    return () => window.removeEventListener('beforeunload', before);
  }, [flush]);

  const setText = useCallback(
    (path: string, text: string) => {
      if (textsRef.current.get(path) === text) return;
      const next = new Map(textsRef.current);
      next.set(path, text);
      textsRef.current = next;
      setTexts(next);
      schedule(path);
    },
    [schedule],
  );

  const updateFields = useCallback(
    (path: string, changes: Record<string, unknown>) => {
      const raw = textsRef.current.get(path);
      if (raw == null) return;
      const { text, crlf } = decodeText(raw);
      const { front, body } = splitFrontMatter(text);
      setText(path, encodeText(joinFrontMatter(setFields(front, changes), body), crlf));
    },
    [setText],
  );

  // ---- the code repository and its commits ----
  const codeKey = `trace.codeRepo.${repo.id}`;
  const [code, setCode] = useState<CodeState>({ repo: null, how: 'none', loading: false, error: null, count: 0 });
  const [rawCommits, setRawCommits] = useState<Commit[]>([]);
  const [codeTick, setCodeTick] = useState(0); // look for the code repository again
  const codeSettings = useMemo(() => parseConfig(config).config.code, [config]);

  const readCommits = useCallback(
    async (entry: RepoEntry, fetchFirst: boolean) => {
      setCode((c) => ({ ...c, loading: true, error: null }));
      try {
        // Show what's here at once; then again after checking the server.
        const first = await api.gitCommits(entry.id, codeSettings.commits, codeSettings.branch);
        setRawCommits(first);
        setCode((c) => ({ ...c, count: first.length }));
        if (fetchFirst) {
          await api.gitFetch(entry.id).catch(() => {});
          const after = await api.gitCommits(entry.id, codeSettings.commits, codeSettings.branch);
          setRawCommits(after);
          setCode((c) => ({ ...c, count: after.length }));
        }
        setCode((c) => ({ ...c, loading: false }));
      } catch (e) {
        setRawCommits([]);
        setCode((c) => ({ ...c, loading: false, error: (e as Error).message, count: 0 }));
      }
    },
    [codeSettings],
  );

  useEffect(() => {
    if (loading) return;
    let live = true;
    (async () => {
      const chosen = load<RepoEntry>(codeKey);
      let entry: RepoEntry | null = chosen;
      let how: CodeState['how'] = chosen ? 'chosen' : 'none';
      if (!entry && codeSettings.repository) {
        entry = await api.findRepoByRemote(codeSettings.repository).catch(() => null);
        how = entry ? 'found' : 'none';
      }
      if (!live) return;
      setCode({ repo: entry, how, loading: false, error: null, count: 0 });
      if (entry) await readCommits(entry, true);
      else setRawCommits([]);
    })();
    return () => {
      live = false;
    };
  }, [codeKey, codeSettings, loading, readCommits, codeTick]);

  const setCodeRepo = useCallback(
    (entry: RepoEntry | null) => {
      save(codeKey, entry);
      if (!entry) return setCodeTick((t) => t + 1);
      setCode({ repo: entry, how: 'chosen', loading: false, error: null, count: 0 });
      void readCommits(entry, true);
    },
    [codeKey, readCommits],
  );

  const reloadCommits = useCallback(async () => {
    if (code.repo) await readCommits(code.repo, true);
  }, [code.repo, readCommits]);

  const index = useMemo(
    () =>
      buildIndex(
        [...texts].map(([path, text]) => ({ path, text })),
        config,
      ),
    [texts, config],
  );
  // ---- Jira ----
  const cfg = index.config;
  const server = useMemo<JiraServer | null>(() => (cfg.jiraUrl ? { url: cfg.jiraUrl, api: cfg.jira.api } : null), [cfg.jiraUrl, cfg.jira.api]);
  const [jira, setJira] = useState<JiraState>({ server: null, status: null, issues: [], loading: false, error: null, read: 0, missing: [] });
  const links = useMemo(() => buildIssueLinks(index, jira.server && server && jira.server.url === server.url ? jira.issues : []), [index, jira.issues, jira.server, server]);
  const commits = useMemo(() => linkCommits(rawCommits, index, links), [rawCommits, index, links]);
  const jiraInputs = useRef({ index, rawCommits });
  jiraInputs.current = { index, rawCommits };

  const withRemoteLinks = useCallback(
    async (srv: JiraServer, issues: JiraIssue[]) => {
      if (!cfg.jira.links.includes('remote-links') || !issues.length) return issues;
      const remote = await api.jiraRemoteLinks(srv, issues.slice(0, 500).map((i) => i.key));
      return issues.map((i) => (remote[i.key] ? { ...i, remoteLinks: remote[i.key] } : i));
    },
    [cfg.jira.links],
  );

  const refreshJira = useCallback(async () => {
    if (!server) return setJira({ server: null, status: null, issues: [], loading: false, error: null, read: 0, missing: [] });
    setJira((j) => ({ ...j, server, loading: true, error: null }));
    try {
      const status = await api.jiraStatus(server);
      if (!status.hasToken || status.error) return setJira((j) => ({ ...j, server, status, loading: false, issues: [], read: 0 }));
      const { index: idx, rawCommits: raw } = jiraInputs.current;
      const base = buildIssueLinks(idx);
      const found = new Map<string, JiraIssue>();
      const missing: string[] = [];
      // The issues that may name requirements (the projects', or jira.jql)…
      const jql = linkQuery(idx, base);
      if (jql) for (const i of (await api.jiraSearch(server, jql, cfg.jira.field, cfg.jira.max)).issues) found.set(i.key, i);
      // …and every issue named in front matter or commits, wherever it is.
      const named = new Set([...base.byIssue.keys(), ...linkCommits(raw, idx, base).flatMap((c) => c.issues)]);
      const rest = [...named].filter((k) => !found.has(k));
      for (let i = 0; i < rest.length; i += 100) {
        const r = await api.jiraSearch(server, `key in (${rest.slice(i, i + 100).join(', ')})`, cfg.jira.field, 100);
        for (const is of r.issues) found.set(is.key, is);
        missing.push(...r.missing);
      }
      const issues = await withRemoteLinks(server, [...found.values()]);
      setJira({ server, status, issues, loading: false, error: null, read: issues.length, missing });
    } catch (e) {
      setJira((j) => ({ ...j, server, loading: false, error: (e as Error).message }));
    }
  }, [server, cfg.jira.field, cfg.jira.max, withRemoteLinks]);

  // Read on opening, and again once commits are known (they name more issues).
  // Not after every reload: Settings → Jira has "Read again".
  const haveCommits = rawCommits.length > 0;
  const autoRead = useRef('');
  useEffect(() => {
    const key = `${server?.url ?? ''}|${server?.api}|${cfg.jira.jql}|${cfg.jira.field}|${cfg.jira.links.join()}|${haveCommits}`;
    if (loading || autoRead.current === key) return;
    autoRead.current = key;
    void refreshJira();
  }, [loading, refreshJira, haveCommits, server, cfg.jira]);

  const searchJira = useCallback(
    async (jql: string) => {
      if (!server) throw new Error('Set jira.url in trace.yml first.');
      const issues = await withRemoteLinks(server, (await api.jiraSearch(server, jql, cfg.jira.field, cfg.jira.max)).issues);
      setJira((j) => {
        const merged = new Map(j.issues.map((i) => [i.key, i]));
        for (const i of issues) merged.set(i.key, i);
        return { ...j, server, issues: [...merged.values()] };
      });
      return issues;
    },
    [server, cfg.jira.field, cfg.jira.max, withRemoteLinks],
  );
  const runsDir = index.config.runs.dir;
  const runs = useMemo(
    () =>
      [...texts]
        .filter(([path]) => path.startsWith(runsDir + '/') && /\.ya?ml$/i.test(path))
        .map(([path, text]) => readRun(path, text))
        .sort((a, b) => b.created.localeCompare(a.created) || b.path.localeCompare(a.path)),
    [texts, runsDir],
  );

  const createFile = useCallback(
    async (path: string, text: string) => {
      await api.writeFile(repo.id, path, text);
      const next = new Map(textsRef.current);
      next.set(path, text);
      textsRef.current = next;
      setTexts(next);
      void refreshGit();
    },
    [repo.id, refreshGit],
  );

  const updateFile = useCallback(
    (path: string, change: (text: string) => string) => {
      const text = textsRef.current.get(path);
      if (text != null) setText(path, change(text));
    },
    [setText],
  );
  const indexRef = useRef(index);
  indexRef.current = index;

  const markReviewed = useCallback(
    (test: Item, reqIds: string[]) => {
      const reviewed = { ...test.reviewed };
      for (const id of reqIds) {
        const req = indexRef.current.byId.get(id);
        if (req) reviewed[id] = fingerprint(req);
      }
      updateFields(test.path, { reviewed });
    },
    [updateFields],
  );

  const writeConfig = useCallback(
    async (text: string) => {
      await api.writeFile(repo.id, 'trace.yml', text);
      setConfig(text);
      void refreshGit();
    },
    [repo.id, refreshGit],
  );

  const createItem = useCallback(
    async (kind: Kind, title: string, opts: { id?: string; verifies?: string[]; refines?: string[]; links?: Record<string, string[]>; components?: string[]; variants?: string[] } = {}) => {
      const idx = indexRef.current;
      // A chosen ID is checked again here: another change may have taken it meanwhile.
      const id = opts.id?.trim() || nextId(idx, kind);
      if (opts.id) {
        const { error } = checkNewId(idx, kind, id);
        if (error) throw new Error(error);
      }
      const type = typeOf(idx.config, kind);
      const prefix = type.prefix;
      const path = newItemPath(idx, kind, id, title);
      const reviewed: Record<string, string> = {};
      // New links start reviewed: they're made against the text as it is now.
      for (const r of [...(opts.verifies ?? []), ...(opts.refines ?? []), ...Object.values(opts.links ?? {}).flat()]) {
        const req = idx.byId.get(r);
        if (req) reviewed[r] = fingerprint(req);
      }
      const status = type.statuses[0] ?? 'draft';
      const links = Object.fromEntries(Object.entries(opts.links ?? {}).filter(([k]) => idx.config.links.some((l) => l.key === k && !l.builtIn && l.from.includes(kind))));
      const text = newItemText(kind, {
        id,
        title,
        status,
        verifies: opts.verifies,
        refines: kind === 'requirement' ? opts.refines : undefined,
        links,
        components: opts.components,
        variants: opts.variants,
        reviewed,
        type: !!prefix && !id.startsWith(prefix),
      });
      await api.writeFile(repo.id, path, text);
      const next = new Map(textsRef.current);
      next.set(path, text);
      textsRef.current = next;
      setTexts(next);
      void refreshGit();
      return path;
    },
    [repo.id, refreshGit],
  );

  const deleteItem = useCallback(
    async (path: string) => {
      clearTimeout(pending.current.get(path));
      pending.current.delete(path);
      await api.deleteFile(repo.id, path);
      const next = new Map(textsRef.current);
      next.delete(path);
      textsRef.current = next;
      setTexts(next);
      void refreshGit();
    },
    [repo.id, refreshGit],
  );

  return { repo, loading, error, config, texts, index, allIndex: index, variant: null, git, saving, code, commits, setCodeRepo, reloadCommits, jira, links, refreshJira, searchJira, reload, setText, updateFields, markReviewed, writeConfig, createItem, deleteItem, runs, createFile, updateFile, flush, refreshGit };
}
