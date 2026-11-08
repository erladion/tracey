// The web version: serves the interface and the same back end over HTTP.
//
//   node out/server/index.js [--workspace DIR] [--repo PATH]… [--port 5180] [--host 127.0.0.1]
//   node out/server/index.js check [DIR]     validate a repository (for CI)
//   node out/server/index.js import-reqif EXPORT.reqifz …   import from DOORS (see backend/cli.ts)
//
// Repositories are the folders in the workspace (default ./repos), plus any given with
// --repo. Set TRACE_TOKEN to require a token: open the app once as /?token=… .
// Jira: TRACE_JIRA_URL (comma-separated for several) says which Jira the server may talk
// to; each person adds their own token in Settings → Jira, kept encrypted in their
// browser. TRACE_JIRA_TOKEN (+ TRACE_JIRA_EMAIL for Cloud) is an optional shared token
// for those who haven't. TRACE_SECRET: the key for those cookies (default: one made
// once and kept in <workspace>/.trace-secret).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, promises as fs, statSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createBackend, readProjectFiles, safePath, type RepoHost } from '../backend/service';
import { createVault, jiraCookies, webJiraCredentials } from '../backend/webjira';
import { API_METHODS, type Api, type RepoEntry } from '../shared/api';

const args = process.argv.slice(2);

if (['import-reqif', 'check', 'export-needs', 'import-needs'].includes(args[0])) {
  const { runCommand } = await import('../backend/cli');
  process.exit((await runCommand(args, 'node out/server/index.js')) ?? 2);
}

function option(name: string, fallback?: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
}
const options = (name: string) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]] : []));

const dev = args.includes('--dev');
const port = Number(option('port', process.env.PORT ?? '5180'));
const host = option('host', process.env.HOST ?? '127.0.0.1')!;
const workspace = resolve(option('workspace', process.env.TRACE_WORKSPACE ?? 'repos')!);
const token = process.env.TRACE_TOKEN ?? '';
await fs.mkdir(workspace, { recursive: true });

// Repositories given with --repo, by folder name.
const extra = new Map<string, string>();
for (const p of options('repo')) extra.set(basename(resolve(p)), resolve(p));

const NAME = /^[\w][\w .-]*$/;

const webHost: RepoHost = {
  async list() {
    const out: RepoEntry[] = [];
    for (const [id, path] of extra) out.push({ id, name: id, location: path });
    for (const e of await fs.readdir(workspace, { withFileTypes: true }))
      if (e.isDirectory() && !e.name.startsWith('.') && !extra.has(e.name)) out.push({ id: e.name, name: e.name, location: `workspace/${e.name}` });
    return out.sort((a, b) => a.name.localeCompare(b.name));
  },
  async resolve(id) {
    const p = extra.get(id) ?? (typeof id === 'string' && NAME.test(id) ? join(workspace, id) : null);
    if (!p || !existsSync(p) || !statSync(p).isDirectory()) throw new Error(`There's no repository “${id}” on this server.`);
    return p;
  },
  async open(id) {
    const path = await this.resolve(id);
    return { id, name: id, location: extra.has(id) ? path : `workspace/${id}` };
  },
  async forget() {},
  async openFolder() {
    return null;
  },
  async newLocation(name) {
    if (!NAME.test(name)) throw new Error('Use letters, digits, spaces, and . - _ in the name.');
    const path = join(workspace, name);
    if (existsSync(path) || extra.has(name)) throw new Error(`There's already a repository named “${name}”.`);
    return { id: name, path };
  },
};

// The key that encrypts the Jira tokens kept in browsers. Kept across restarts so
// people don't have to enter their tokens again.
async function secret(): Promise<string> {
  if (process.env.TRACE_SECRET) return process.env.TRACE_SECRET;
  const p = join(workspace, '.trace-secret');
  try {
    return (await fs.readFile(p, 'utf8')).trim();
  } catch {
    const s = randomBytes(32).toString('hex');
    await fs.writeFile(p, s, { mode: 0o600 });
    return s;
  }
}

// Jira: only the addresses in TRACE_JIRA_URL, so a repository's trace.yml can't point
// the server (or anyone's token) somewhere else.
const jiraUrls = (process.env.TRACE_JIRA_URL ?? '').split(',').map((u) => u.trim()).filter(Boolean);
const backend = createBackend(webHost, webJiraCredentials(createVault(await secret()), jiraUrls));

// ---- HTTP --------------------------------------------------------------------------------

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.md': 'text/plain; charset=utf-8',
};

function send(res: ServerResponse, status: number, body: string | Buffer, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 32 * 1024 * 1024) reject(new Error('Too large.'));
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function cookie(req: IncomingMessage, name: string): string | null {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(req.headers.cookie ?? '');
  return m ? decodeURIComponent(m[1]) : null;
}

// Behind a proxy that ends HTTPS, it says so in X-Forwarded-Proto.
const secure = (req: IncomingMessage) => 'encrypted' in req.socket || /^https\b/i.test(String(req.headers['x-forwarded-proto'] ?? ''));

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function authorized(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  if (!token) return true;
  const given = url.searchParams.get('token');
  if (given && same(given, token)) {
    res.appendHeader('Set-Cookie', `trace_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/${secure(req) ? '; Secure' : ''}`);
    return true;
  }
  const c = cookie(req, 'trace_token');
  return !!c && same(c, token);
}

const JIRA_COOKIE = 'trace_jira';

async function handleApi(req: IncomingMessage, res: ServerResponse, method: string) {
  if (req.method !== 'POST') return send(res, 405, '{"error":"POST only"}');
  // A JSON body can't be sent cross-site without a preflight, which we never allow.
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, '{"error":"JSON only"}');
  if (!(API_METHODS as string[]).includes(method)) return send(res, 404, JSON.stringify({ error: `No such call: ${method}` }));
  try {
    const params = JSON.parse((await readBody(req)) || '[]');
    if (!Array.isArray(params)) throw new Error('Arguments must be a list.');
    const fn = backend[method as keyof Api] as (...a: unknown[]) => Promise<unknown>;
    // This person's Jira tokens: an encrypted cookie only the API sees.
    const jar = {
      get: () => cookie(req, JIRA_COOKIE),
      set: (v: string | null) =>
        res.appendHeader(
          'Set-Cookie',
          `${JIRA_COOKIE}=${v ?? ''}; HttpOnly; SameSite=Strict; Path=/api/; Max-Age=${v ? 180 * 24 * 3600 : 0}${secure(req) ? '; Secure' : ''}`,
        ),
    };
    const value = await jiraCookies.run(jar, () => fn(...params));
    send(res, 200, JSON.stringify({ value: value ?? null }));
  } catch (e) {
    send(res, 200, JSON.stringify({ error: (e as Error).message || String(e) }));
  }
}

// Images and other files from a repository: /files/<repo>/<path>
async function handleFile(res: ServerResponse, rest: string) {
  const slash = rest.indexOf('/');
  if (slash < 0) return send(res, 404, 'Not found', 'text/plain');
  try {
    const root = await webHost.resolve(decodeURIComponent(rest.slice(0, slash)));
    const full = safePath(root, decodeURIComponent(rest.slice(slash + 1)));
    const type = TYPES[extname(full).toLowerCase()];
    if (!type || type.startsWith('text/html')) return send(res, 403, 'Not served', 'text/plain');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    send(res, 200, await fs.readFile(full), type);
  } catch {
    send(res, 404, 'Not found', 'text/plain');
  }
}

const here = fileURLToPath(new URL('.', import.meta.url));
const staticDir = resolve(here, '../renderer');

async function handleStatic(res: ServerResponse, path: string) {
  let full = resolve(staticDir, '.' + decodeURIComponent(path));
  if (!full.startsWith(staticDir) || !existsSync(full) || statSync(full).isDirectory()) full = join(staticDir, 'index.html');
  if (!existsSync(full)) return send(res, 500, 'The interface isn’t built. Run `npm run build`, or start with --dev.', 'text/plain');
  const type = TYPES[extname(full)] ?? 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': full.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' });
  res.end(await fs.readFile(full));
}

type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
let vite: Middleware | null = null;
if (dev) {
  const { createServer: createVite } = await import('vite');
  const server = await createVite({ configFile: resolve(process.cwd(), 'vite.web.config.ts'), server: { middlewareMode: true }, appType: 'spa' });
  vite = server.middlewares;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (!authorized(req, res, url)) return send(res, 401, 'Open the link with ?token=… to sign in.', 'text/plain');
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url.pathname.slice(5));
  if (url.pathname.startsWith('/files/')) return handleFile(res, url.pathname.slice(7));
  if (vite) return vite(req, res, () => send(res, 404, 'Not found', 'text/plain'));
  return handleStatic(res, url.pathname);
});

server.listen(port, host, () => {
  console.log(`Tracey is running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/  (repositories in ${workspace})`);
  if (!token && host !== '127.0.0.1' && host !== 'localhost') console.warn('Warning: listening beyond this computer without TRACE_TOKEN; anyone who can reach it can edit and push.');
});
