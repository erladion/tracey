// The back end both front doors share: the desktop app (over IPC) and the web server
// (over HTTP). Where repositories come from differs between them, so that part is a
// RepoHost; everything else is here.
import { promises as fs, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Api, Identity, ProjectFiles, RepoEntry } from '../shared/api';
import { CONFIG_FILES, parseConfig } from '../core/config';
import { projectFiles } from '../core/sample';
import { looksLike, MAX_IMAGE_BYTES } from '../core/images';
import { git, GitError, remoteKey } from './git';
import { createJira, type JiraCredentials } from './jira';

export interface RepoHost {
  list(): Promise<RepoEntry[]>;
  resolve(id: string): Promise<string>; // the folder; throws if not allowed
  open(id: string): Promise<RepoEntry>;
  forget(id: string): Promise<void>;
  openFolder(): Promise<RepoEntry | null>;
  // Where a clone or new project goes: a new folder `name`, or null when cancelled.
  newLocation(name: string): Promise<{ id: string; path: string } | null>;
}

const SKIP_DIRS = new Set(['node_modules', 'out', 'dist', 'build', 'target', 'venv', '__pycache__', '_build']);
const MAX_FILES = 20_000;

// A path inside the repository, never outside it or in .git.
export function safePath(root: string, rel: string): string {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) throw new Error('Not a valid path.');
  const full = resolve(root, rel);
  const r = relative(root, full);
  if (!r || r.startsWith('..') || resolve(r) === r || r.split(sep).includes('.git')) throw new Error(`“${rel}” is outside the repository.`);
  return full;
}

async function walk(root: string, dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= MAX_FILES) return;
    if (e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) await walk(root, full, out);
    } else if (e.isFile() && /\.md$/i.test(e.name)) out.push(full);
  }
}

export async function readProjectFiles(root: string): Promise<ProjectFiles> {
  let config: string | null = null;
  let configFound = false;
  for (const name of CONFIG_FILES) {
    const p = join(root, name);
    if (existsSync(p)) {
      config = await fs.readFile(p, 'utf8');
      configFound = true;
      break;
    }
  }
  // With settings, look where they say items are; without, anywhere in the repository.
  const cfg = parseConfig(config).config;
  const dirs = configFound ? [...new Set([cfg.requirements.dir, cfg.testcases.dir])].filter((d) => existsSync(join(root, d))) : [''];
  const paths: string[] = [];
  for (const d of dirs) await walk(root, d ? safePath(root, d) : root, paths);
  const files = [];
  for (const p of paths) {
    const text = await fs.readFile(p, 'utf8');
    if (/^\uFEFF?---[ \t]*\r?\n/.test(text)) files.push({ path: relative(root, p).split(sep).join('/'), text });
  }
  // Test runs: YAML files in their own folder.
  const runsDir = join(root, cfg.runs.dir);
  if (cfg.runs.dir && existsSync(runsDir)) {
    for (const e of await fs.readdir(runsDir, { withFileTypes: true }))
      if (e.isFile() && /\.ya?ml$/i.test(e.name)) files.push({ path: `${cfg.runs.dir}/${e.name}`, text: await fs.readFile(join(runsDir, e.name), 'utf8') });
  }
  return { config, files };
}

// The requirements and test cases as they were in a commit (no test runs: those are
// read as they are now). null if the commit isn't in this copy of the repository.
export async function readProjectFilesAt(root: string, commit: string): Promise<ProjectFiles | null> {
  const tree = await git.tree(root, commit);
  if (!tree) return null;
  const configEntry = CONFIG_FILES.map((f) => tree.find((e) => e.path === f)).find(Boolean);
  const config = configEntry ? (await git.blobs(root, [configEntry.id]))[0] : null;
  const cfg = parseConfig(config).config;
  const dirs = config != null ? [...new Set([cfg.requirements.dir, cfg.testcases.dir])] : [''];
  const inDirs = (p: string) => dirs.some((d) => !d || p.startsWith(d.replace(/\/+$/, '') + '/'));
  const wanted = tree
    .filter((e) => /\.md$/i.test(e.path) && inDirs(e.path) && !e.path.split('/').some((s) => s.startsWith('.') || SKIP_DIRS.has(s)))
    .slice(0, MAX_FILES);
  const texts = await git.blobs(
    root,
    wanted.map((e) => e.id),
  );
  const files = wanted.map((e, i) => ({ path: e.path, text: texts[i] })).filter((f) => /^\uFEFF?---[ \t]*\r?\n/.test(f.text));
  return { config, files };
}

export function createBackend(host: RepoHost, jiraCreds: JiraCredentials): Api {
  const root = (repo: string) => host.resolve(repo);
  const jira = createJira(jiraCreds);

  async function writeProject(dest: string, examples: boolean) {
    for (const [rel, text] of Object.entries(projectFiles(examples))) {
      const p = join(dest, rel);
      await fs.mkdir(dirname(p), { recursive: true });
      await fs.writeFile(p, text);
    }
  }

  return {
    listRepos: () => host.list(),
    openFolder: () => host.openFolder(),
    openRepo: (id) => host.open(id),
    forgetRepo: (id) => host.forget(id),

    async cloneRepo(url) {
      const name = url.replace(/\/+$/, '').split(/[/:]/).pop()?.replace(/\.git$/, '') || 'repository';
      const loc = await host.newLocation(name);
      if (!loc) return null;
      await git.clone(url, loc.path, dirname(loc.path));
      return host.open(loc.id);
    },

    async createProject(name, examples) {
      if (!/^[\w][\w .-]*$/.test(name)) throw new Error('Use letters, digits, spaces, and . - _ in the name.');
      const loc = await host.newLocation(name);
      if (!loc) return null;
      await fs.mkdir(loc.path, { recursive: true });
      await writeProject(loc.path, examples);
      await git.init(loc.path).catch(() => {});
      return host.open(loc.id);
    },

    async loadFiles(repo) {
      return readProjectFiles(await root(repo));
    },
    async loadFilesAt(repo, commit) {
      const r = await root(repo);
      return (await git.isRepo(r)) ? readProjectFilesAt(r, String(commit)) : null;
    },

    async writeFile(repo, path, text) {
      if (typeof text !== 'string') throw new Error('Nothing to write.');
      const full = safePath(await root(repo), path);
      await fs.mkdir(dirname(full), { recursive: true });
      // Write then rename, so a crash never leaves half a file.
      const tmp = `${full}.${process.pid}.tmp`;
      await fs.writeFile(tmp, text);
      await fs.rename(tmp, full);
    },

    async addImage(repo, path, data) {
      const r = await root(repo);
      const m = typeof path === 'string' ? /^(.*?)(\.(png|jpe?g|gif|webp))$/i.exec(path) : null;
      if (!m) throw new Error('Only PNG, JPEG, GIF and WebP images can be added.');
      if (typeof data !== 'string' || data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4) throw new Error('The image is too large (10 MB at most).');
      const bytes = Buffer.from(data, 'base64');
      if (!looksLike(m[3].toLowerCase(), bytes)) throw new Error('That file isn’t the image its name says.');
      for (let i = 1; ; i++) {
        const rel = i === 1 ? path : `${m[1]}-${i}${m[2]}`;
        const full = safePath(r, rel);
        await fs.mkdir(dirname(full), { recursive: true });
        try {
          await fs.writeFile(full, bytes, { flag: 'wx' }); // never over an existing file
          return rel;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || i > 999) throw e;
        }
      }
    },

    async deleteFile(repo, path) {
      await fs.rm(safePath(await root(repo), path), { force: true });
    },

    gitStatus: async (repo) => git.status(await root(repo)),
    gitIdentity: async (repo) => git.identity(await root(repo)),
    async gitCommit(repo, message, paths, author: Identity | null) {
      const r = await root(repo);
      if (await git.merging(r)) throw new Error('Getting the latest stopped on conflicts: resolve them (or cancel) first.');
      for (const p of paths) safePath(r, p);
      await git.commit(r, message, paths, author && author.name && author.email ? author : null);
    },
    gitFetch: async (repo) => git.fetch(await root(repo)),
    gitPull: async (repo, author) => git.pull(await root(repo), author && author.name && author.email ? author : null),
    async gitConflict(repo, path) {
      const r = await root(repo);
      safePath(r, path);
      return git.conflict(r, path);
    },
    async gitResolve(repo, path, text) {
      const r = await root(repo);
      const full = safePath(r, path);
      if (text == null) await fs.rm(full, { force: true });
      else {
        await fs.mkdir(dirname(full), { recursive: true });
        await fs.writeFile(full, text);
      }
      await git.markResolved(r, path);
    },
    gitFinishMerge: async (repo, author) => git.finishMerge(await root(repo), author && author.name && author.email ? author : null),
    gitAbortMerge: async (repo) => git.abortMerge(await root(repo)),
    gitPush: async (repo) => git.push(await root(repo)),
    gitBranches: async (repo) => git.branches(await root(repo)),
    gitCheckout: async (repo, branch, create) => git.checkout(await root(repo), branch, create),
    async gitLog(repo, path) {
      const r = await root(repo);
      safePath(r, path);
      return git.log(r, path);
    },
    async gitCommits(repo, limit, branch) {
      const r = await root(repo);
      return (await git.isRepo(r)) ? git.commits(r, limit, branch) : [];
    },
    async exportPdf() {
      throw new Error('PDFs are made by the browser here: use its print dialog and choose “Save as PDF”.');
    },
    jiraStatus: (server) => jira.status(server),
    jiraSetToken: (server, token, email) => jira.setToken(server, token, email),
    jiraSearch: (server, jql, field, max) => jira.search(server, jql, field, max),
    jiraRemoteLinks: (server, keys) => jira.remoteLinks(server, keys),
    gitTags: async (repo) => git.tags(await root(repo)),
    gitRange: async (repo, from, to) => git.range(await root(repo), from, to),
    gitCommitOf: async (repo, ref) => git.verifyRef(await root(repo), String(ref)),
    async findRepoByRemote(url) {
      const want = remoteKey(url);
      for (const entry of await host.list()) {
        try {
          const remote = await git.remoteUrl(await host.resolve(entry.id));
          if (remote && remoteKey(remote) === want) return entry;
        } catch {
          // gone or not a repository
        }
      }
      return null;
    },
    async gitBlame(repo, path) {
      const r = await root(repo);
      safePath(r, path);
      return git.blame(r, path);
    },
    async gitShow(repo, commit, path) {
      const r = await root(repo);
      safePath(r, path);
      return git.show(r, commit, path);
    },
  };
}

export { GitError };
