// Jira tokens in the web version: each person's own, kept in their browser as a cookie
// the server encrypts (AES-256-GCM) with its secret. The server stores no one's token,
// a cookie can't be read by the page's scripts or changed without the secret, and
// tokens only ever go to the Jira addresses the server is set up for (TRACE_JIRA_URL).
// A token in TRACE_JIRA_TOKEN, if any, is shared: used by whoever hasn't added their own.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { envAuth, normalizeUrl, type JiraAuth, type JiraCredentials } from './jira';

const AAD = Buffer.from('trace-jira-tokens-v1');
const MAX_COOKIE = 3500; // browsers keep cookies up to about 4 KB

export interface Vault {
  seal(data: unknown): string;
  open<T>(sealed: string): T | null; // null: not ours, changed, or made with another secret
}

export function createVault(secret: string | Buffer): Vault {
  const key = createHash('sha256').update(secret).digest();
  return {
    seal(data) {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, iv);
      c.setAAD(AAD);
      const body = Buffer.concat([c.update(JSON.stringify(data), 'utf8'), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url');
    },
    open<T>(sealed: string): T | null {
      try {
        const b = Buffer.from(sealed, 'base64url');
        if (b.length < 29) return null;
        const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
        d.setAAD(AAD);
        d.setAuthTag(b.subarray(12, 28));
        return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8')) as T;
      } catch {
        return null;
      }
    },
  };
}

// The request being answered: its Jira cookie, and a way to replace it (null: remove).
export interface JiraCookieJar {
  get(): string | null;
  set(value: string | null): void;
}
export const jiraCookies = new AsyncLocalStorage<JiraCookieJar>();

type Tokens = Record<string, { token: string; email: string | null }>;

// allowed: the Jira addresses requests may go to.
export function webJiraCredentials(vault: Vault, allowed: string[]): JiraCredentials {
  const ok = new Set(allowed.map(normalizeUrl).filter(Boolean));
  const read = (jar: JiraCookieJar | undefined): Tokens => {
    const raw = jar?.get();
    const t = raw ? vault.open<Tokens>(raw) : null;
    return t && typeof t === 'object' && !Array.isArray(t) ? t : {};
  };
  return {
    canStore: true,
    storedIn: 'browser',
    allowed: (url) => ok.has(normalizeUrl(url)),
    async get(url): Promise<JiraAuth | null> {
      const own = read(jiraCookies.getStore())[normalizeUrl(url)];
      if (own && typeof own.token === 'string' && own.token) return { token: own.token, email: typeof own.email === 'string' ? own.email : null };
      const shared = envAuth(url);
      return shared ? { ...shared, shared: true } : null;
    },
    async set(url, auth) {
      const jar = jiraCookies.getStore();
      if (!jar) throw new Error('No browser to keep the token in.');
      if (!ok.has(normalizeUrl(url))) throw new Error(`This server only talks to the Jira in TRACE_JIRA_URL; ${url} isn't it.`);
      const tokens = read(jar);
      if (auth) tokens[normalizeUrl(url)] = { token: auth.token, email: auth.email };
      else delete tokens[normalizeUrl(url)];
      const sealed = Object.keys(tokens).length ? vault.seal(tokens) : null;
      if (sealed && sealed.length > MAX_COOKIE) throw new Error('That token is too long to keep in the browser.');
      jar.set(sealed);
    },
  };
}
