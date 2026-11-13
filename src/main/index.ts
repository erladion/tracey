// The desktop app: one window, the shared back end over IPC, and the folders the
// user has opened (most recent first) in the app's settings.
import { app, BrowserWindow, dialog, ipcMain, net, protocol, safeStorage, session, shell } from 'electron';
import { existsSync, promises as fs, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBackend, safePath, type RepoHost } from '../backend/service';
import { envAuth, normalizeUrl, type JiraAuth, type JiraCredentials } from '../backend/jira';
import { envLlm, normalizeLlmUrl, type LlmStore } from '../backend/llm';
import { API_METHODS, type Api, type RepoEntry } from '../shared/api';
import { desktopCommand, helpText } from '../backend/commandline';

if (process.env.TRACE_USER_DATA) app.setPath('userData', process.env.TRACE_USER_DATA);

// Run from a terminal with a command (`Tracey.AppImage import-reqif …`, `… check`), the
// app does that and exits, without a window. A mistyped command says so instead of opening.
// Run from source (`electron [switches] . [args]`), the app's folder is among them: not a command.
const argv = process.argv.slice(1);
if (!app.isPackaged) argv.splice(Math.max(0, argv.findIndex((a) => !a.startsWith('-'))), 1);
const command = desktopCommand(argv);
const isCommand = command !== null;
if (command) {
  // An AppImage runs from its own mount; OWD is the folder it was started in.
  if (process.env.OWD) process.chdir(process.env.OWD);
  const self = process.env.APPIMAGE ? `./${basename(process.env.APPIMAGE)}` : app.isPackaged ? basename(process.execPath) : 'electron .';
  if (command[0] === 'help') {
    console.log(helpText(self));
    app.exit(0);
  } else if (command[0] === 'version') {
    console.log(`Tracey ${app.getVersion()}`);
    app.exit(0);
  } else if (command[0] === 'unknown') {
    const what = command[1]?.startsWith('-') ? `${command[1]} needs a command before it.` : `“${command[1]}” isn’t a command.`;
    console.error(`${what}\n\n${helpText(self)}`);
    app.exit(2);
  } else void import('../backend/cli').then(async ({ runCommand }) => app.exit((await runCommand(command, self)) ?? 2));
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
async function readTokens(): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(tokensPath(), 'utf8'));
  } catch {
    return {};
  }
}
// A session of its own for Jira's REST API and the language model's, sending what an API
// client (curl) would: no browser User-Agent, no Sec-Fetch headers, no cookies.
let jiraSes: Electron.Session | null = null;
function jiraSession(): Electron.Session {
  if (jiraSes) return jiraSes;
  const ses = session.fromPartition('tracey-jira');
  ses.setUserAgent(`Tracey/${app.getVersion()}`);
  ses.webRequest.onBeforeSendHeaders((details, done) => {
    const headers = Object.fromEntries(Object.entries(details.requestHeaders).filter(([k]) => !/^sec-fetch-|^sec-ch-|^accept-language$/i.test(k)));
    done({ requestHeaders: headers });
  });
  return (jiraSes = ses);
}

// Secrets (Jira tokens, the language model's API key): encrypted with the system keychain,
// or, on a computer without one (Linux without a keyring), kept as they are in a file only
// this user can read, as gh and docker do. Stored before as an encrypted string; as
// { plain } without a keychain.
const keychain = () => safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text';
type Sealed = string | { plain: string };
const seal = (secret: string): Sealed => (keychain() ? safeStorage.encryptString(secret).toString('base64') : { plain: secret });
function unseal(v: unknown): string | null {
  if (v && typeof v === 'object' && typeof (v as { plain?: unknown }).plain === 'string') return (v as { plain: string }).plain;
  if (typeof v !== 'string' || !v || !safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(v, 'base64'));
  } catch {
    return null;
  }
}

const desktopJira: JiraCredentials = {
  canStore: true,
  storedIn: 'computer',
  allowed: () => true,
  // Chromium's network stack, as a browser on this computer: the certificates the system
  // trusts (a company's own certificate authority) and its proxy settings. But not as a
  // browser to Jira, which treats those more strictly than API clients (403).
  fetch: (url, init) => jiraSession().fetch(String(url), init),
  encrypted: () => keychain(),
  // The token saved here, else TRACE_JIRA_URL + TRACE_JIRA_TOKEN.
  async get(url) {
    const saved = unseal((await readTokens())[normalizeUrl(url)]);
    if (saved)
      try {
        return JSON.parse(saved) as JiraAuth;
      } catch {
        // Not readable: as if there were none.
      }
    return envAuth(url);
  },
  async set(url, auth) {
    const tokens = await readTokens();
    if (!auth) delete tokens[normalizeUrl(url)];
    else tokens[normalizeUrl(url)] = seal(JSON.stringify(auth));
    await fs.mkdir(app.getPath('userData'), { recursive: true });
    await fs.writeFile(tokensPath(), JSON.stringify(tokens, null, 2), { mode: 0o600 });
  },
};

// The language model: each user's, in llm.json beside the settings (the API key sealed like
// Jira tokens). TRACE_LLM_URL, _MODEL, _KEY… are the defaults: what's saved here wins, and
// the environment's key is only sent to the environment's address.
const llmPath = () => join(app.getPath('userData'), 'llm.json');
type SavedLlm = { url?: string; model?: string; key?: Sealed | null; think?: boolean; candidates?: number };
async function readLlm(): Promise<SavedLlm> {
  try {
    return JSON.parse(await fs.readFile(llmPath(), 'utf8')) as SavedLlm;
  } catch {
    return {};
  }
}
const desktopLlm: LlmStore = {
  editable: true,
  desktop: true,
  keychain: () => keychain(),
  fetch: (url, init) => jiraSession().fetch(String(url), init),
  async get() {
    const saved = await readLlm();
    const env = envLlm();
    if (!saved.url) return env ? { ...env, keyFrom: env.key ? 'environment' : null } : null;
    const own = unseal(saved.key);
    const envKey = env && env.url === normalizeLlmUrl(saved.url) ? env.key : null;
    return {
      url: saved.url,
      model: saved.model ?? '',
      key: own ?? envKey,
      keyFrom: own ? (typeof saved.key === 'string' ? 'keychain' : 'file') : envKey ? 'environment' : null,
      think: !!saved.think,
      candidates: Number(saved.candidates) || 0,
    };
  },
  async set(setup) {
    const old = await readLlm();
    const key = setup.key === undefined ? (old.key ?? null) : setup.key ? seal(setup.key) : null;
    await fs.mkdir(app.getPath('userData'), { recursive: true });
    await fs.writeFile(llmPath(), JSON.stringify({ url: setup.url, model: setup.model, key, think: setup.think, candidates: setup.candidates }, null, 2), { mode: 0o600 });
  },
};

const backend: Api = { ...createBackend(desktopHost, desktopJira, desktopLlm), exportPdf };

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
