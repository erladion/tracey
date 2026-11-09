// The desktop app: one window, the shared back end over IPC, and the folders the
// user has opened (most recent first) in the app's settings.
import { app, BrowserWindow, dialog, ipcMain, net, protocol, safeStorage, shell } from 'electron';
import { existsSync, promises as fs, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBackend, safePath, type RepoHost } from '../backend/service';
import { envAuth, normalizeUrl, type JiraAuth, type JiraCredentials } from '../backend/jira';
import { API_METHODS, type Api, type RepoEntry } from '../shared/api';

if (process.env.TRACE_USER_DATA) app.setPath('userData', process.env.TRACE_USER_DATA);

// Run from a terminal with a command (`Tracey.AppImage import-reqif …`, `… check`), the
// app does that and exits, without a window. Chromium's own switches may come first.
const argv = process.argv.slice(app.isPackaged ? 1 : 2);
const command = argv.slice(argv.findIndex((a) => !a.startsWith('-')));
const isCommand = ['import-reqif', 'import-html', 'check', 'export-needs', 'import-needs'].includes(command[0]);
if (isCommand) {
  // An AppImage runs from its own mount; OWD is the folder it was started in.
  if (process.env.OWD) process.chdir(process.env.OWD);
  const self = process.env.APPIMAGE ? basename(process.env.APPIMAGE) : app.isPackaged ? basename(process.execPath) : 'electron .';
  void import('../backend/cli').then(async ({ runCommand }) => app.exit((await runCommand(command, self)) ?? 2));
}

protocol.registerSchemesAsPrivileged([{ scheme: 'trace-file', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

let win: BrowserWindow | null = null;

// ---- settings --------------------------------------------------------------------

interface Settings {
  recent: string[];
}
const settingsPath = () => join(app.getPath('userData'), 'settings.json');
async function loadSettings(): Promise<Settings> {
  try {
    const s = JSON.parse(await fs.readFile(settingsPath(), 'utf8'));
    return { recent: Array.isArray(s.recent) ? s.recent.filter((p: unknown) => typeof p === 'string') : [] };
  } catch {
    return { recent: [] };
  }
}
async function saveSettings(s: Settings) {
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await fs.writeFile(settingsPath(), JSON.stringify(s, null, 2));
}

const entry = (path: string): RepoEntry => ({ id: path, name: basename(path), location: path });

const desktopHost: RepoHost = {
  async list() {
    return (await loadSettings()).recent.filter((p) => existsSync(p)).map(entry);
  },
  async resolve(id) {
    const p = resolve(String(id));
    if (!existsSync(p) || !statSync(p).isDirectory()) throw new Error(`The folder ${id} isn't there any more.`);
    return p;
  },
  async open(id) {
    const p = await this.resolve(id);
    const s = await loadSettings();
    s.recent = [p, ...s.recent.filter((r) => r !== p)].slice(0, 12);
    await saveSettings(s);
    return entry(p);
  },
  async forget(id) {
    const s = await loadSettings();
    s.recent = s.recent.filter((r) => r !== id);
    await saveSettings(s);
  },
  async openFolder() {
    const r = await dialog.showOpenDialog(win!, { title: 'Open a repository', properties: ['openDirectory'] });
    return r.canceled || !r.filePaths[0] ? null : this.open(r.filePaths[0]);
  },
  async newLocation(name) {
    const r = await dialog.showOpenDialog(win!, { title: `Where should “${name}” go?`, buttonLabel: 'Choose', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const path = join(r.filePaths[0], name);
    if (existsSync(path)) throw new Error(`There's already a folder named “${name}” there.`);
    return { id: path, path };
  },
};

// Jira tokens: each user's own, encrypted with the system keychain (safeStorage), by Jira
// address. TRACE_JIRA_URL + TRACE_JIRA_TOKEN in the environment work too.
const tokensPath = () => join(app.getPath('userData'), 'jira-tokens.json');
async function readTokens(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await fs.readFile(tokensPath(), 'utf8'));
  } catch {
    return {};
  }
}
const desktopJira: JiraCredentials = {
  canStore: true,
  storedIn: 'computer',
  allowed: () => true,
  async get(url) {
    const env = envAuth(url);
    if (env) return env;
    const stored = (await readTokens())[normalizeUrl(url)];
    if (!stored || !safeStorage.isEncryptionAvailable()) return null;
    try {
      return JSON.parse(safeStorage.decryptString(Buffer.from(stored, 'base64'))) as JiraAuth;
    } catch {
      return null;
    }
  },
  async set(url, auth) {
    const tokens = await readTokens();
    if (!auth) delete tokens[normalizeUrl(url)];
    else {
      if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text')
        throw new Error('This computer has no keychain to keep the token safe in. Set TRACE_JIRA_URL and TRACE_JIRA_TOKEN in the environment instead.');
      tokens[normalizeUrl(url)] = safeStorage.encryptString(JSON.stringify(auth)).toString('base64');
    }
    await fs.mkdir(app.getPath('userData'), { recursive: true });
    await fs.writeFile(tokensPath(), JSON.stringify(tokens, null, 2), { mode: 0o600 });
  },
};

const backend: Api = { ...createBackend(desktopHost, desktopJira), exportPdf };

// Renders the document in a hidden window (no scripts, nothing but the page) and saves
// it as a PDF where the user chooses.
async function exportPdf(html: string, fileName: string): Promise<string | null> {
  if (typeof html !== 'string' || html.length > 50_000_000) throw new Error('Nothing to export.');
  const name = String(fileName || 'document.pdf').replace(/[\\/:*?"<>|]+/g, '-').replace(/(\.pdf)?$/i, '.pdf');
  const r = await dialog.showSaveDialog(win!, { title: 'Save as PDF', defaultPath: join(app.getPath('documents'), name), filters: [{ name: 'PDF', extensions: ['pdf'] }] });
  if (r.canceled || !r.filePath) return null;
  const tmp = join(app.getPath('temp'), `trace-export-${process.pid}-${Date.now()}.html`);
  await fs.writeFile(tmp, html);
  const view = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true, contextIsolation: true } });
  view.webContents.on('will-navigate', (e) => e.preventDefault());
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  try {
    await view.loadFile(tmp);
    const pdf = await view.webContents.printToPDF({ printBackground: true, pageSize: 'A4', preferCSSPageSize: true, generateDocumentOutline: true });
    await fs.writeFile(r.filePath, pdf);
    void shell.openPath(r.filePath);
    return r.filePath;
  } finally {
    view.destroy();
    await fs.rm(tmp, { force: true });
  }
}

ipcMain.handle('api', async (_e, method: string, args: unknown[]) => {
  if (!(API_METHODS as string[]).includes(method)) throw new Error(`No such call: ${method}`);
  try {
    return { value: (await (backend[method as keyof Api] as (...a: unknown[]) => Promise<unknown>)(...(args ?? []))) ?? null };
  } catch (e) {
    return { error: (e as Error).message || String(e) };
  }
});

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 760,
    minHeight: 500,
    title: 'Tracey',
    backgroundColor: '#F6F6F3',
    autoHideMenuBar: true,
    webPreferences: { preload: join(import.meta.dirname, '../preload/index.cjs'), sandbox: true, contextIsolation: true },
  });
  // Links open in the browser, never in the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win!.webContents.getURL()) {
      e.preventDefault();
      if (/^https?:/.test(url)) void shell.openExternal(url);
    }
  });
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  win.on('closed', () => (win = null));
}

app.whenReady().then(() => {
  if (isCommand) return;
  // Images in pages: trace-file://repo/<repo id>/<path in repo>
  protocol.handle('trace-file', async (req) => {
    try {
      const url = new URL(req.url);
      const [repo, ...rest] = url.pathname.slice(1).split('/');
      const root = await desktopHost.resolve(decodeURIComponent(repo));
      const full = safePath(root, decodeURIComponent(rest.join('/')));
      return net.fetch(pathToFileURL(full).toString());
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
  createWindow();
});

app.on('window-all-closed', () => app.quit());
