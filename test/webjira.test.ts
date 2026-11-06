import { afterEach, describe, expect, it } from 'vitest';
import { createVault, jiraCookies, webJiraCredentials, type JiraCookieJar } from '../src/backend/webjira';

const JIRA = 'https://jira.example.com';

// One browser: its cookie, as the server would see it on the next request.
function browser(): JiraCookieJar & { value: string | null } {
  const b = {
    value: null as string | null,
    get: () => b.value,
    set: (v: string | null) => {
      b.value = v;
    },
  };
  return b;
}

afterEach(() => {
  delete process.env.TRACE_JIRA_URL;
  delete process.env.TRACE_JIRA_TOKEN;
});

describe('vault', () => {
  it('opens what it sealed, and nothing changed or sealed with another secret', () => {
    const v = createVault('one');
    const sealed = v.seal({ a: 'plain-secret' });
    expect(v.open(sealed)).toEqual({ a: 'plain-secret' });
    expect(Buffer.from(sealed, 'base64url').toString()).not.toContain('plain-secret');
    const flipped = Buffer.from(sealed, 'base64url');
    flipped[flipped.length - 1] ^= 1;
    expect(v.open(flipped.toString('base64url'))).toBeNull();
    expect(createVault('two').open(sealed)).toBeNull();
    expect(v.open('junk')).toBeNull();
  });
});

describe('Jira tokens in the web version', () => {
  const creds = webJiraCredentials(createVault('secret'), [JIRA]);

  it('keeps each browser its own token', async () => {
    const alice = browser();
    const bob = browser();
    await jiraCookies.run(alice, () => creds.set(`${JIRA}/`, { token: 'alice-pat', email: null }));
    expect(alice.value).not.toContain('alice-pat');
    expect(await jiraCookies.run(alice, () => creds.get(JIRA))).toEqual({ token: 'alice-pat', email: null });
    expect(await jiraCookies.run(bob, () => creds.get(JIRA))).toBeNull();
    // Removing it clears the cookie.
    await jiraCookies.run(alice, () => creds.set(JIRA, null));
    expect(alice.value).toBeNull();
  });

  it('falls back to the shared token, marked as shared', async () => {
    process.env.TRACE_JIRA_URL = JIRA;
    process.env.TRACE_JIRA_TOKEN = 'team-pat';
    const alice = browser();
    expect(await jiraCookies.run(alice, () => creds.get(JIRA))).toEqual({ token: 'team-pat', email: null, shared: true });
    await jiraCookies.run(alice, () => creds.set(JIRA, { token: 'alice-pat', email: null }));
    expect(await jiraCookies.run(alice, () => creds.get(JIRA))).toEqual({ token: 'alice-pat', email: null });
  });

  it('only talks to the configured Jira', async () => {
    expect(creds.allowed(JIRA.toUpperCase() + '/')).toBe(true);
    expect(creds.allowed('https://evil.example.com')).toBe(false);
    await expect(jiraCookies.run(browser(), () => creds.set('https://evil.example.com', { token: 't', email: null }))).rejects.toThrow(/TRACE_JIRA_URL/);
  });

  it('ignores a cookie made with another secret', async () => {
    const alice = browser();
    await jiraCookies.run(alice, () => webJiraCredentials(createVault('old'), [JIRA]).set(JIRA, { token: 'x', email: null }));
    expect(await jiraCookies.run(alice, () => creds.get(JIRA))).toBeNull();
  });
});
