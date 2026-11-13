// The web server's connections (Jira, the language model) made like curl on the same
// machine, after Smith's network.ts (github.com/erladion/Smith):
// - trusting the system's certificate store too (what update-ca-trust manages on RHEL,
//   the Windows store), not only Node's built-in authorities, so a company's own
//   certificate authority works without NODE_EXTRA_CA_CERTS;
// - using HTTPS_PROXY / HTTP_PROXY / NO_PROXY from the environment.
// Both where this Node has them (24 and later); otherwise nothing changes. The desktop app
// doesn't need this: its requests go through Chromium, which does both already.
import http from 'node:http';
import tls from 'node:tls';

export function useSystemNetworkSettings(): void {
  try {
    const t = tls as unknown as { getCACertificates?: (which: string) => string[]; setDefaultCACertificates?: (certs: string[]) => void };
    if (typeof t.getCACertificates === 'function' && typeof t.setDefaultCACertificates === 'function')
      t.setDefaultCACertificates([...new Set([...t.getCACertificates('default'), ...t.getCACertificates('extra'), ...t.getCACertificates('system')])]);
  } catch {
    // Not supported, or the system store can't be read: Node's own authorities stay.
  }
  try {
    const setProxy = (http as unknown as { setGlobalProxyFromEnv?: () => void }).setGlobalProxyFromEnv;
    if (typeof setProxy === 'function') setProxy();
  } catch {
    // Not supported here: NODE_USE_ENV_PROXY=1 does the same at start.
  }
}
