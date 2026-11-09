import { describe, expect, it } from 'vitest';
import { reachError } from '../src/backend/jira';

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
