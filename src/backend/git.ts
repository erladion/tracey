// Git through the system's own `git`, which brings HTTPS and SSH, the user's keys
// and their credential helpers. Never prompts: a question git would ask fails instead.
import { execFile } from 'node:child_process';
import type { Branches, ChangeKind, Commit, FileCommit, GitStatus, Identity } from '../shared/api';

// No `ext::` transport (it runs arbitrary commands); paths printed as they are.
const SAFE = ['-c', 'protocol.ext.allow=never', '-c', 'core.quotepath=false'];

export class GitError extends Error {
  constructor(
    message: string,
    public output = '',
  ) {
    super(message);
  }
}

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], cwd: string, extra: string[] = []): Promise<Result> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...SAFE, ...extra, ...args],
      {
        cwd,
        env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes', ELECTRON_RUN_AS_NODE: undefined },
        maxBuffer: 64 * 1024 * 1024,
        encoding: 'utf8',
        timeout: 10 * 60_000,
      },
      (error, stdout, stderr) => {
        if (error && typeof (error as NodeJS.ErrnoException).code === 'string') return reject(new GitError(`Couldn't run git: ${error.message}. Is git installed?`));
        resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
      },
    );
  });
}

async function checked(args: string[], cwd: string, extra: string[] = []): Promise<string> {
  const r = await run(args, cwd, extra);
  if (r.code !== 0) throw new GitError(explain(r.stderr || r.stdout), r.stderr + r.stdout);
  return r.stdout;
}

// Git's own messages, made shorter where we know what they mean.
function explain(output: string): string {
  const o = output.trim();
  if (/terminal prompts disabled|could not read Username|Authentication failed/i.test(o))
    return 'The server asked for a login. Set up a git credential helper (or an SSH key) for this server, then try again.';
  if (/Permission denied \(publickey\)|Host key verification failed/i.test(o)) return 'The SSH key was refused, or the server is unknown. Check that `git clone` works from a terminal.';
  if (/Please tell me who you are|user\.email/i.test(o)) return 'Git doesn’t know your name and email yet. Set them, then commit again.';
  if (/no upstream|has no upstream branch/i.test(o)) return 'This branch isn’t on the server yet. Push it first.';
  if (/CONFLICT|could not apply/i.test(o)) return `Your changes conflict with what’s on the server.\n\n${o}`;
  const lines = o.split('\n').filter((l) => l.startsWith('fatal:') || l.startsWith('error:'));
  return (lines.length ? lines.join('\n') : o).replace(/^(fatal|error): /gm, '') || 'Git failed.';
}

function changeKind(xy: string): ChangeKind {
  if (xy.includes('U') || xy === 'AA' || xy === 'DD') return 'conflicted';
  if (xy.includes('D')) return 'deleted';
  if (xy.includes('A')) return 'added';
  if (xy.includes('R')) return 'renamed';
  return 'modified';
}

export function isCloneUrl(url: string): boolean {
  return /^(https?|ssh|git):\/\/[^\s]+$/.test(url) || /^[\w.-]+@[\w.-]+:[^\s]+$/.test(url);
}

// The same repository whatever the protocol: Bitbucket's https://host/scm/proj/repo.git
// and ssh://git@host:7999/proj/repo.git both become host/proj/repo.
export function remoteKey(url: string): string {
  let u = url.trim().replace(/\.git\/?$/, '').replace(/\/+$/, '');
  const scp = /^[\w.-]+@([\w.-]+):(?!\/\/)(.+)$/.exec(u);
  let host: string;
  let path: string;
  if (scp) [host, path] = [scp[1], scp[2]];
  else {
    try {
      const p = new URL(u);
      [host, path] = [p.hostname, p.pathname];
    } catch {
      return u.toLowerCase();
    }
  }
  const parts = path.split('/').filter(Boolean);
  return `${host}/${parts.slice(-2).join('/')}`.toLowerCase();
}

export function repoName(url: string): string {
  return (url.replace(/\/+$/, '').split(/[/:]/).pop() ?? 'repository').replace(/\.git$/, '') || 'repository';
}

export const git = {
  async isRepo(root: string): Promise<boolean> {
    try {
      const r = await run(['rev-parse', '--is-inside-work-tree'], root);
      return r.code === 0 && r.stdout.trim() === 'true';
    } catch {
      return false;
    }
  },

  async init(root: string): Promise<void> {
    await checked(['init', '-q', '-b', 'main'], root);
  },

  async clone(url: string, dest: string, cwd: string): Promise<void> {
    if (!isCloneUrl(url)) throw new GitError('That doesn’t look like a repository link (https://…, ssh://… or git@host:path).');
    await checked(['clone', '--', url, dest], cwd);
  },

  async status(root: string): Promise<GitStatus | null> {
    if (!(await git.isRepo(root))) return null;
    const out = await checked(['--no-optional-locks', 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], root);
    const status: GitStatus = { branch: null, upstream: null, hasRemote: false, head: null, ahead: 0, behind: 0, changes: [] };
    const head = await run(['rev-parse', '--verify', '--quiet', 'HEAD'], root);
    status.head = head.code === 0 ? head.stdout.trim() : null;
    status.hasRemote = (await run(['remote'], root)).stdout.trim() !== '';
    const entries = out.split('\0');
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.startsWith('# branch.head ')) status.branch = e.slice(14) === '(detached)' ? null : e.slice(14);
      else if (e.startsWith('# branch.upstream ')) status.upstream = e.slice(18);
      else if (e.startsWith('# branch.ab ')) {
        const m = /\+(\d+) -(\d+)/.exec(e);
        if (m) [status.ahead, status.behind] = [Number(m[1]), Number(m[2])];
      } else if (e.startsWith('1 ') || e.startsWith('u ')) {
        const parts = e.split(' ');
        status.changes.push({ path: parts.slice(e.startsWith('u ') ? 10 : 8).join(' '), kind: changeKind(parts[1]) });
      } else if (e.startsWith('2 ')) {
        status.changes.push({ path: e.split(' ').slice(9).join(' '), kind: 'renamed', from: entries[++i] });
      } else if (e.startsWith('? ')) status.changes.push({ path: e.slice(2), kind: 'added' });
    }
    return status;
  },

  async identity(root: string): Promise<Identity | null> {
    const get = async (key: string) => (await run(['config', '--get', key], root)).stdout.trim();
    const [name, email] = await Promise.all([get('user.name'), get('user.email')]);
    return name && email ? { name, email } : null;
  },

  async commit(root: string, message: string, paths: string[], author: Identity | null): Promise<void> {
    if (!message.trim()) throw new GitError('Write a message saying what changed.');
    if (!paths.length) throw new GitError('Nothing selected to commit.');
    const who = author ? ['-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`] : [];
    // Only what was chosen: reset the index first so nothing else rides along.
    await run(['reset', '-q'], root);
    await checked(['add', '-A', '--', ...paths], root);
    await checked(['commit', '-q', '-m', message], root, who);
  },

  async fetch(root: string): Promise<void> {
    await checked(['fetch', '--prune', '--quiet'], root);
  },

  async pull(root: string): Promise<string> {
    const r = await run(['pull', '--rebase', '--autostash'], root);
    if (r.code !== 0) {
      // Leave the repository as it was rather than mid-rebase.
      await run(['rebase', '--abort'], root);
      throw new GitError(explain(r.stderr || r.stdout), r.stderr);
    }
    return (r.stdout + r.stderr).trim();
  },

  async push(root: string): Promise<string> {
    const s = await git.status(root);
    const args = s?.upstream ? ['push'] : ['push', '-u', 'origin', 'HEAD'];
    const r = await run(args, root);
    if (r.code !== 0) {
      if (/rejected|fetch first|non-fast-forward/.test(r.stderr)) throw new GitError('The server has changes you don’t have yet. Get the latest first, then push.', r.stderr);
      throw new GitError(explain(r.stderr || r.stdout), r.stderr);
    }
    return (r.stdout + r.stderr).trim();
  },

  async branches(root: string): Promise<Branches> {
    const [cur, local, remote] = await Promise.all([
      run(['branch', '--show-current'], root),
      checked(['branch', '--format=%(refname:short)'], root),
      run(['branch', '-r', '--format=%(refname:short)'], root),
    ]);
    const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean);
    return {
      current: cur.stdout.trim() || null,
      local: lines(local),
      remote: lines(remote.stdout).filter((b) => !b.endsWith('/HEAD') && b.includes('/')),
    };
  },

  async checkout(root: string, branch: string, create: boolean): Promise<void> {
    if (!/^[\w./-]+$/.test(branch) || branch.startsWith('-')) throw new GitError('Branch names can use letters, digits, and . / - _');
    await checked(create ? ['switch', '-c', branch] : ['switch', branch], root);
  },

  async log(root: string, path: string): Promise<FileCommit[]> {
    const r = await run(['log', '--follow', '-n', '100', '--format=%H%x1f%an%x1f%aI%x1f%s%x1e', '--', path], root);
    if (r.code !== 0) return [];
    return r.stdout
      .split('\x1e')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [commit, author, date, message] = l.split('\x1f');
        return { commit, author, date, message };
      });
  },

  async remoteUrl(root: string): Promise<string | null> {
    const r = await run(['remote', 'get-url', 'origin'], root);
    return r.code === 0 ? r.stdout.trim() : null;
  },

  // `branch` as on the server (origin/branch) if known there, else the local one, else HEAD.
  async resolveRef(root: string, branch: string | null): Promise<string> {
    if (!branch || !/^[\w./-]+$/.test(branch) || branch.startsWith('-')) return 'HEAD';
    for (const ref of [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`])
      if ((await run(['rev-parse', '--verify', '--quiet', ref], root)).code === 0) return ref;
    return 'HEAD';
  },

  async commits(root: string, limit: number, branch: string | null = null): Promise<Commit[]> {
    const n = Math.max(1, Math.min(5000, Math.floor(limit) || 300));
    const ref = await git.resolveRef(root, branch);
    const r = await run(['log', '-n', String(n), '--name-only', LOG_FORMAT, ref, '--'], root);
    return r.code === 0 ? parseLog(r.stdout) : [];
  },

  async tags(root: string): Promise<string[]> {
    const r = await run(['tag', '--list', '--sort=-v:refname'], root);
    return r.code === 0 ? r.stdout.split('\n').map((t) => t.trim()).filter(Boolean) : [];
  },

  // A tag, branch (local or the server's) or commit, as a commit hash.
  async verifyRef(root: string, ref: string): Promise<string> {
    if (!/^[\w./^~-]+$/.test(ref) || ref.startsWith('-')) throw new GitError(`“${ref}” isn't a version name.`);
    for (const candidate of [ref, `origin/${ref}`]) {
      const r = await run(['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`], root);
      if (r.code === 0) return r.stdout.trim();
    }
    throw new GitError(`There's no tag, branch or commit “${ref}” in the code repository. Get the latest, or check the name.`);
  },

  async range(root: string, from: string, to: string): Promise<{ commits: Commit[]; to: string }> {
    const [a, b] = [await git.verifyRef(root, from), await git.verifyRef(root, to)];
    const r = await run(['log', '--name-only', LOG_FORMAT, `${a}..${b}`, '--'], root);
    if (r.code !== 0) throw new GitError(explain(r.stderr));
    return { commits: parseLog(r.stdout), to: b };
  },

  async show(root: string, commit: string, path: string): Promise<string | null> {
    if (!/^[0-9a-f]{4,64}$/i.test(commit)) return null;
    const r = await run(['show', `${commit}:${path}`], root);
    return r.code === 0 ? r.stdout : null;
  },
};

const LOG_FORMAT = '--format=%x1e%H%x1f%an%x1f%aI%x1f%s%x1f%b%x1f';

function parseLog(out: string): Commit[] {
  return out
    .split('\x1e')
    .filter((c) => c.trim())
    .map((chunk) => {
      const [hash, author, date, subject, body, rest = ''] = chunk.split('\x1f');
      return { hash, author, date, subject, body: body.trim(), files: rest.split('\n').map((l) => l.trim()).filter(Boolean) };
    });
}

