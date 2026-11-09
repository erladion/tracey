import { describe, expect, it } from 'vitest';
import { forbidden, reachError } from '../src/backend/jira';

const nodeError = (code: string, message: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(message), { code }) });

describe('why Jira could not be reached', () => {
  it('says what Node keeps in the cause of "fetch failed"', () => {
    expect(reachError(nodeError('ENOTFOUND', 'getaddrinfo ENOTFOUND jira.example.com'), 'https://jira.example.com', false)).toBe(
      'Couldn\'t reach Jira at https://jira.example.com: fetch failed: getaddrinfo ENOTFOUND jira.example.com. That name isn’t known on this network: check jira.url in trace.yml, and whether a VPN is needed.',
    );
    expect(reachError(nodeError('SELF_SIGNED_CERT_IN_CHAIN', 'self-signed certificate in certificate chain'), 'https://jira', false)).toContain(
      '(SELF_SIGNED_CERT_IN_CHAIN). Its certificate isn’t one Node trusts: start the server with NODE_EXTRA_CA_CERTS',
    );
  });

  it('reads Chromium’s errors in the desktop app', () => {
    expect(reachError(new Error('net::ERR_CERT_AUTHORITY_INVALID'), 'https://jira', true)).toContain('isn’t one this computer trusts');
    expect(reachError(new Error('net::ERR_PROXY_CONNECTION_FAILED'), 'https://jira', true)).toContain('The proxy refused or failed');
    expect(reachError(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }), 'https://jira', true)).toContain('No answer within a minute');
  });
});

describe('why Jira answered 403', () => {
  const res = (h: Record<string, string> = {}) => ({ headers: { get: (n: string) => h[n.toLowerCase()] ?? null } });
  const at = 'https://jira/rest/api/2/myself';
  it('names a CAPTCHA, a page from something in front of Jira, and what Jira said', () => {
    expect(forbidden(res({ 'x-authentication-denied-reason': 'CAPTCHA_CHALLENGE; login-url=https://jira/login.jsp' }), '', at)).toContain('it wants a CAPTCHA after failed logins');
    expect(forbidden(res(), '<!DOCTYPE html><html><head><title>Sign in to your account</title></head></html>', at)).toContain('with a web page (“Sign in to your account”) rather than Jira’s answer');
    expect(forbidden(res(), '{"errorMessages":["You do not have the permission to see the specified issue."]}', at)).toBe(
      'Jira said no (403) at https://jira/rest/api/2/myself: “You do not have the permission to see the specified issue”. The token’s user may lack permission to see this.',
    );
    expect(forbidden(res({ 'x-seraph-loginreason': 'AUTHENTICATION_DENIED' }), '', at)).toContain('the token wasn’t accepted (AUTHENTICATION_DENIED)');
    expect(forbidden(res(), 'XSRF check failed', at)).toContain('“XSRF check failed” (its protection');
  });
});
