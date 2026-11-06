// The back end, over Electron IPC in the desktop app or HTTP in the browser.
import { API_METHODS, type Api } from '../../shared/api';

interface Desktop {
  invoke(method: string, args: unknown[]): Promise<{ value?: unknown; error?: string }>;
}

const desktop = (window as unknown as { traceDesktop?: Desktop }).traceDesktop;

export const platform: 'desktop' | 'web' = desktop ? 'desktop' : 'web';

async function call(method: string, args: unknown[]): Promise<unknown> {
  let r: { value?: unknown; error?: string };
  if (desktop) r = await desktop.invoke(method, args);
  else {
    const res = await fetch(`api/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
    if (res.status === 401) throw new Error('Signed out: open the link with ?token=… again.');
    if (!res.ok) throw new Error(`The server answered ${res.status}.`);
    r = await res.json();
  }
  if (r.error) throw new Error(r.error);
  return r.value;
}

export const api = Object.fromEntries(API_METHODS.map((m) => [m, (...args: unknown[]) => call(m, args)])) as unknown as Api;

// A URL for a file in the repository (images in pages).
export function fileUrl(repo: string, path: string): string {
  const p = path.split('/').map(encodeURIComponent).join('/');
  return desktop ? `trace-file://repo/${encodeURIComponent(repo)}/${p}` : `files/${encodeURIComponent(repo)}/${p}`;
}
