// A small Jira REST client: Data Center / Server (API 2, personal access token as a
// Bearer token) and Cloud (API 3, email + API token). Only reads.
import type { JiraIssue, JiraServer, JiraStatus } from '../shared/api';

export interface JiraAuth {
  token: string;
  email: string | null; // Cloud only
  shared?: boolean; // the web server's own token, used by everyone without one
}

// Where tokens come from: the desktop app keeps each user's, encrypted on their computer;
// the web server keeps each user's in their browser (webjira.ts). Both also accept
// TRACE_JIRA_URL + TRACE_JIRA_TOKEN (+ TRACE_JIRA_EMAIL for Cloud).
export interface JiraCredentials {
  canStore: boolean;
  storedIn: 'computer' | 'browser';
  allowed(url: string): boolean; // whether requests may go to this server at all
  get(url: string): Promise<JiraAuth | null>;
  set(url: string, auth: JiraAuth | null): Promise<void>;
  // How requests go out: the desktop app's goes through Chromium's network stack, which
  // trusts the certificates the operating system trusts and uses its proxy settings.
  fetch?: typeof fetch;
}

export const normalizeUrl = (url: string) => url.trim().replace(/\/+$/, '').toLowerCase();

export function envAuth(url: string): JiraAuth | null {
  const u = process.env.TRACE_JIRA_URL;
  const token = process.env.TRACE_JIRA_TOKEN;
  if (!u || !token || normalizeUrl(u) !== normalizeUrl(url)) return null;
  return { token, email: process.env.TRACE_JIRA_EMAIL || null };
}

class JiraError extends Error {}

// Why a request got no answer, in words. Node says only "fetch failed" and keeps the
// reason in `cause`; Chromium (the desktop app) says net::ERR_….
export function reachError(e: unknown, base: string, desktop: boolean): string {
  const err = e as Error & { cause?: { code?: string; message?: string } };
  const code = err.cause?.code ?? /net::(ERR_[A-Z_]+)/.exec(err.message)?.[1] ?? '';
  const detail = err.cause?.message && err.cause.message !== err.message ? `${err.message}: ${err.cause.message}` : err.message;
  const why =
    err.name === 'TimeoutError' || /TIMEOUT|TIMED_OUT/.test(code)
      ? 'No answer within a minute. Is a VPN needed to reach it?'
      : /ENOTFOUND|EAI_AGAIN|NAME_NOT_RESOLVED/.test(code)
        ? 'That name isn’t known on this network: check jira.url in trace.yml, and whether a VPN is needed.'
        : /ECONNREFUSED|CONNECTION_REFUSED/.test(code)
          ? 'Nothing answers at that address: check jira.url (and its port) in trace.yml.'
          : /CERT|SELF_SIGNED|UNABLE_TO_|ISSUER|SSL|TLS/.test(code)
            ? desktop
              ? 'Its certificate isn’t one this computer trusts: the company’s certificate authority may need installing (ask IT).'
              : 'Its certificate isn’t one Node trusts: start the server with NODE_EXTRA_CA_CERTS=/path/to/company-ca.pem.'
            : /PROXY|TUNNEL/.test(code)
              ? 'The proxy refused or failed: check the proxy settings.'
              : '';
  return `Couldn't reach Jira at ${base}: ${detail}${code && !detail.includes(code) ? ` (${code})` : ''}.${why ? ` ${why}` : ''}`;
}

function check(server: JiraServer): string {
  if (!/^https?:\/\/[^\s/]+/.test(server.url)) throw new JiraError('Set jira.url in trace.yml to the address of your Jira (https://…).');
  if (server.api !== 2 && server.api !== 3) throw new JiraError('jira.api must be 2 (Data Center / Server) or 3 (Cloud).');
  return server.url.replace(/\/+$/, '');
}

export function createJira(creds: JiraCredentials) {
  const fieldIds = new Map<string, Map<string, string>>(); // server → field name → id

  async function request<T>(server: JiraServer, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const base = check(server);
    if (!creds.allowed(server.url)) throw new JiraError(`This server only sends requests to the Jira in its TRACE_JIRA_URL, and ${server.url} isn't it.`);
    const auth = await creds.get(server.url);
    if (!auth) throw new JiraError(creds.canStore ? 'No Jira token yet: add one under Settings → Jira.' : 'The server has no Jira token: set TRACE_JIRA_URL and TRACE_JIRA_TOKEN where it runs.');
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (server.api === 3) headers.Authorization = `Basic ${Buffer.from(`${auth.email ?? ''}:${auth.token}`).toString('base64')}`;
    else headers.Authorization = `Bearer ${auth.token}`;
    if (init.body) headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await (creds.fetch ?? fetch)(`${base}/rest/api/${server.api}${path}`, {
        method: init.method ?? 'GET',
        headers,
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(60_000),
        redirect: 'error',
      });
    } catch (e) {
      throw new JiraError(reachError(e, base, creds.storedIn === 'computer'));
    }
    if (res.status === 401) throw new JiraError('Jira refused the token (401). Check it, and that it hasn’t expired.');
    if (res.status === 403) throw new JiraError('Jira said no (403): the token’s user may lack permission, or Jira wants a CAPTCHA after failed logins.');
    if (res.status === 404) throw new JiraError(`Not found at ${base}/rest/api/${server.api}${path.split('?')[0]}: check jira.url and jira.api.`);
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      throw new JiraError(`Jira answered ${res.status} with something that isn't JSON. Is ${base} really Jira?`);
    }
    if (!res.ok) {
      const j = json as { errorMessages?: string[]; errors?: Record<string, string> } | null;
      const msg = [...(j?.errorMessages ?? []), ...Object.values(j?.errors ?? {})].join(' ') || `HTTP ${res.status}`;
      throw new JiraError(msg);
    }
    return json as T;
  }

  async function fieldId(server: JiraServer, field: string): Promise<string> {
    if (/^customfield_\d+$/.test(field) || /^[a-z]+$/.test(field)) return field;
    const key = normalizeUrl(server.url);
    if (!fieldIds.has(key)) {
      const fields = await request<{ id: string; name: string }[]>(server, '/field');
      fieldIds.set(key, new Map(fields.map((f) => [f.name.toLowerCase(), f.id])));
    }
    const id = fieldIds.get(key)!.get(field.toLowerCase());
    if (!id) throw new JiraError(`Jira has no field named “${field}” (jira.field in trace.yml).`);
    return id;
  }

  return {
    async status(server: JiraServer): Promise<JiraStatus> {
      const auth = await creds.get(server.url).catch(() => null);
      const base = { hasToken: !!auth, shared: !!auth?.shared, canStore: creds.canStore, storedIn: creds.storedIn };
      if (!auth) return { ...base, user: null, error: null };
      try {
        const me = await request<{ displayName?: string; name?: string; emailAddress?: string }>(server, '/myself');
        return { ...base, user: me.displayName ?? me.name ?? me.emailAddress ?? '?', error: null };
      } catch (e) {
        return { ...base, user: null, error: (e as Error).message };
      }
    },

    async setToken(server: JiraServer, token: string, email: string | null) {
      check(server);
      if (!creds.canStore) throw new JiraError('Tokens are set where the server runs (TRACE_JIRA_TOKEN).');
      await creds.set(server.url, token.trim() ? { token: token.trim(), email: email?.trim() || null } : null);
    },

    async search(server: JiraServer, jql: string, field: string | null, max: number): Promise<{ issues: JiraIssue[]; total: number; missing: string[] }> {
      const limit = Math.max(1, Math.min(10_000, Math.floor(max) || 1000));
      const fid = field ? await fieldId(server, field) : null;
      const fields = ['summary', 'status', 'issuetype', 'labels', 'fixVersions', 'description', ...(fid ? [fid] : [])];
      const missing: string[] = [];
      let query = jql;
      // `key in (…)` fails as a whole if one key doesn't exist (any more): drop those and retry.
      for (let attempt = 0; ; attempt++) {
        try {
          const raw: Record<string, unknown>[] = [];
          let total = 0;
          if (server.api === 3) {
            let next: string | undefined;
            do {
              const page = await request<{ issues: Record<string, unknown>[]; nextPageToken?: string; isLast?: boolean }>(server, '/search/jql', {
                method: 'POST',
                body: { jql: query, fields, maxResults: Math.min(100, limit - raw.length), nextPageToken: next },
              });
              raw.push(...page.issues);
              next = page.isLast === false || page.nextPageToken ? page.nextPageToken : undefined;
            } while (next && raw.length < limit);
            total = raw.length;
          } else {
            while (raw.length < limit) {
              const page = await request<{ issues: Record<string, unknown>[]; total: number }>(server, '/search', {
                method: 'POST',
                body: { jql: query, fields, startAt: raw.length, maxResults: Math.min(100, limit - raw.length) },
              });
              raw.push(...page.issues);
              total = page.total;
              if (!page.issues.length || raw.length >= page.total) break;
            }
          }
          return { issues: raw.map((r) => toIssue(server, r, fid)), total, missing };
        } catch (e) {
          const gone = [...(e as Error).message.matchAll(/issue with key '([^']+)' does not exist/gi)].map((m) => m[1]);
          if (!gone.length || attempt > 5) throw e;
          missing.push(...gone);
          for (const k of gone) query = query.replace(new RegExp(`\\s*,?\\s*"?${k}"?\\s*(?=[,)])`, 'g'), '').replace(/\(\s*,/g, '(');
          if (/\(\s*\)/.test(query)) return { issues: [], total: 0, missing };
        }
      }
    },

    async remoteLinks(server: JiraServer, keys: string[]): Promise<Record<string, { url: string; title: string }[]>> {
      const out: Record<string, { url: string; title: string }[]> = {};
      const queue = keys.filter((k) => /^[A-Z][A-Z0-9_]*-\d+$/.test(k)).slice(0, 2000);
      const worker = async () => {
        for (let k = queue.shift(); k; k = queue.shift()) {
          try {
            const links = await request<{ object?: { url?: string; title?: string } }[]>(server, `/issue/${encodeURIComponent(k)}/remotelink`);
            out[k] = links.map((l) => ({ url: l.object?.url ?? '', title: l.object?.title ?? '' }));
          } catch {
            out[k] = [];
          }
        }
      };
      await Promise.all(Array.from({ length: 6 }, worker));
      return out;
    },
  };
}

// ---- issue JSON → JiraIssue ---------------------------------------------------------

// Cloud's rich text (Atlassian Document Format) as plain text.
function adfText(node: unknown): string {
  if (!node || typeof node !== 'object') return typeof node === 'string' ? node : '';
  const n = node as { type?: string; text?: string; content?: unknown[]; attrs?: { url?: string; text?: string } };
  if (n.type === 'text') return n.text ?? '';
  if (n.type === 'inlineCard' || n.type === 'mention') return ` ${n.attrs?.url ?? n.attrs?.text ?? ''} `;
  const inner = (n.content ?? []).map(adfText).join(n.type === 'doc' ? '\n' : '');
  return /paragraph|heading|listItem|codeBlock/.test(n.type ?? '') ? inner + '\n' : inner;
}

function values(v: unknown): string[] {
  if (v == null) return [];
  if (typeof v === 'string' || typeof v === 'number') return [String(v)];
  if (Array.isArray(v)) return v.flatMap(values);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (o.type === 'doc') return [adfText(o)];
    for (const k of ['value', 'name', 'key', 'displayName']) if (typeof o[k] === 'string') return [o[k] as string];
  }
  return [];
}

function toIssue(server: JiraServer, raw: Record<string, unknown>, fid: string | null): JiraIssue {
  const f = (raw.fields ?? {}) as Record<string, unknown>;
  const status = (f.status ?? {}) as { name?: string; statusCategory?: { key?: string } };
  const cat = status.statusCategory?.key;
  return {
    key: String(raw.key),
    summary: String(f.summary ?? ''),
    status: status.name ?? '',
    statusCategory: cat === 'new' || cat === 'indeterminate' || cat === 'done' ? cat : '',
    type: String((f.issuetype as { name?: string } | undefined)?.name ?? ''),
    labels: values(f.labels),
    fixVersions: values(f.fixVersions),
    description: server.api === 3 ? adfText(f.description) : String(f.description ?? ''),
    field: fid ? values(f[fid]) : [],
    remoteLinks: null,
  };
}
