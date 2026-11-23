// Sphinx-Needs projects on disk and in git: MyST files read as needs, needs written back
// into their files, and git's per-file answers (status, history, blame) given per need.
// The pure part is core/myst.ts.
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Blame, FileCommit, GitStatus, GitChange } from '../shared/api';
import { CONFIG_FILES, parseConfig, typeKey, typeOf, type Kind, type TraceConfig } from '../core/config';
import { decodeText, encodeText, readFrontMatter, splitFrontMatter } from '../core/frontmatter';
import {
  explodeNeeds,
  kindByPrefix,
  needsSeen,
  kindOfDirective,
  mayHoldNeeds,
  needPath,
  needPaths,
  needText,
  needToItemText,
  readConfPy,
  readNeedFile,
  removeNeed,
  sphinxConfigText,
  withoutNeeds,
  withSphinxTypes,
  writeNeed,
  type NeedContext,
  type NeedSeen,
  type NeedFile,
  type NeedKey,
  type SphinxDeclared,
} from '../core/myst';
import { git } from './git';

// Where a Sphinx project's conf.py usually is, when there's no trace.yml to say.
const CONF_DIRS = ['docs', 'doc', 'source', 'docs/source', ''];

// A conf.py loading sphinx_needs, among the usual places: its folder and text.
export async function findSphinx(read: (path: string) => Promise<string | null>): Promise<{ dir: string; conf: string } | null> {
  for (const dir of CONF_DIRS) {
    const text = await read(dir ? `${dir}/conf.py` : 'conf.py');
    if (text != null && readConfPy(text)?.usesNeeds) return { dir, conf: text };
  }
  return null;
}

const readOrNull = (full: string) => fs.readFile(full, 'utf8').catch(() => null);

// Every item's type by ID, from the last time the project was read: links in needs read
// from git (history, status) are told apart by what they link to.
const kindsByRoot = new Map<string, Map<string, Kind | null>>();
// And its needs, which settle the types conf.py declares (their prefixes and statuses).
const seenByRoot = new Map<string, NeedSeen[]>();

export interface Sphinx {
  config: TraceConfig;
  declared: SphinxDeclared | null;
}

// The project's settings, when it's a Sphinx-Needs project: trace.yml's, or (without one)
// those of a conf.py loading sphinx_needs.
export async function sphinxSettings(root: string): Promise<Sphinx | null> {
  for (const name of CONFIG_FILES) {
    const text = await readOrNull(join(root, name));
    if (text == null) continue;
    const config = parseConfig(text).config;
    return config.sphinx ? settled(root, config, readConfPy(await readOrNull(join(root, config.sphinx.conf)))) : null;
  }
  const found = await findSphinx((p) => readOrNull(join(root, p)));
  return found ? settled(root, parseConfig(`sphinx-needs:\n  dir: ${found.dir || '.'}\n`).config, readConfPy(found.conf)) : null;
}

const settled = (root: string, config: TraceConfig, declared: SphinxDeclared | null): Sphinx => ({ config: withSphinxTypes(config, declared, seenByRoot.get(root) ?? []), declared });

export function needContext(root: string, s: Sphinx, file?: NeedFile): NeedContext {
  const kinds = kindsByRoot.get(root);
  const own = new Map(file?.needs.map((n) => [n.id, kindOfDirective(s.config, n.name)]) ?? []);
  return { config: s.config, declared: s.declared, kindOfId: (id) => (own.has(id) ? own.get(id)! : (kinds?.get(id) ?? kindByPrefix(s.config, id))) };
}

// ---- reading a project ------------------------------------------------------------------

export interface ReadFiles {
  config: string | null;
  plain: { path: string; text: string }[]; // Markdown with front matter
  myst: { path: string; text: string }[]; // Markdown that may hold needs
  read: (path: string) => Promise<string | null>; // any file, by its path in the repository
  kindOf: (file: { path: string; text: string }) => Kind | null; // a plain file's item type
}

// The needs among the files as items' texts, conf.py with them, and trace.yml (made up
// from conf.py when there's none). `myst` files without needs, and all of them when it
// isn't a Sphinx-Needs project, are read as plain files when they have front matter.
export async function withNeeds(root: string | null, r: ReadFiles): Promise<{ config: string | null; files: { path: string; text: string }[] }> {
  let configText = r.config;
  let config = parseConfig(configText).config;
  let made: { dir: string } | null = null;
  const front = (f: { text: string }) => /^\uFEFF?---[ \t]*\r?\n/.test(f.text);
  // Not a Sphinx-Needs project: files with front matter are items as always.
  const notSphinx = { config: configText, files: [...r.plain, ...r.myst.filter(front)] };
  if (configText == null) {
    const found = await findSphinx(r.read);
    if (!found) return notSphinx;
    made = found;
    config = parseConfig(`sphinx-needs:\n  dir: ${found.dir || '.'}\n`).config;
  }
  if (!config.sphinx) return notSphinx;
  const confPath = config.sphinx.conf;
  const confText = await r.read(confPath);
  const declared = readConfPy(confText);
  const needFiles: NeedFile[] = [];
  const plain = [...r.plain];
  for (const f of r.myst) {
    const file = readNeedFile(f.path, decodeText(f.text).text, config, declared);
    if (file.needs.length) needFiles.push(file);
    else if (/^﻿?---[ \t]*\r?\n/.test(f.text)) plain.push(f);
  }
  // As buildIndex reads it: with conf.py's types.
  const seen = needsSeen(needFiles);
  if (made) {
    configText = sphinxConfigText(made.dir, needFiles, withSphinxTypes(config, declared, seen), declared);
    config = parseConfig(configText).config;
  }
  config = withSphinxTypes(config, declared, seen);
  if (root) seenByRoot.set(root, seen);
  const kinds = new Map<string, Kind | null>();
  for (const f of plain) {
    const id = String(readFrontMatter(splitFrontMatter(decodeText(f.text).text).front).data.id ?? '').trim();
    if (id) kinds.set(id, r.kindOf(f));
  }
  for (const f of needFiles) for (const n of f.needs) if (n.id && !kinds.has(n.id)) kinds.set(n.id, kindOfDirective(config, n.name));
  if (root) kindsByRoot.set(root, kinds);
  const needs = explodeNeeds(needFiles, config, declared, (id) => kinds.get(id) ?? null);
  return { config: configText, files: [...plain, ...needs, ...(confText != null ? [{ path: confPath, text: confText }] : [])] };
}

// ---- writing ------------------------------------------------------------------------------

// One write at a time per file: two needs in one file saved at once must not race.
const locks = new Map<string, Promise<unknown>>();
function locked<T>(key: string, f: () => Promise<T>): Promise<T> {
  const run = (locks.get(key) ?? Promise.resolve()).catch(() => {}).then(f);
  locks.set(key, run);
  void run.finally(() => locks.get(key) === run && locks.delete(key)).catch(() => {});
  return run;
}

async function writeAtomic(full: string, text: string) {
  await fs.mkdir(dirname(full), { recursive: true });
  const tmp = `${full}.${process.pid}.tmp`;
  await fs.writeFile(tmp, text);
  await fs.rename(tmp, full);
}

async function settingsOrFail(root: string): Promise<Sphinx> {
  const s = await sphinxSettings(root);
  if (!s) throw new Error('This isn’t a Sphinx-Needs project (no sphinx-needs: in trace.yml, and no conf.py loading sphinx_needs), so needs can’t be written.');
  return s;
}

// A need's item text written into its MyST file. full: the file's path on disk.
export function writeNeedFile(root: string, key: NeedKey, full: string, text: string): Promise<void> {
  return locked(full, async () => {
    const s = await settingsOrFail(root);
    const raw = (await readOrNull(full)) ?? '';
    const { text: now, crlf } = decodeText(raw);
    const data = readFrontMatter(splitFrontMatter(decodeText(text).text).front).data;
    const id = String(data.id ?? '').trim();
    const kind = typeKey(s.config.types, String(data.type ?? '')) ?? kindByPrefix(s.config, id);
    const file = readNeedFile(key.file, now, s.config, s.declared);
    await writeAtomic(full, encodeText(writeNeed(now, key, decodeText(text).text, needContext(root, s, file), typeOf(s.config, kind ?? 'requirement').plural), crlf));
    // Links to it written next know what it is (a new need, or a new ID).
    if (id) kindsByRoot.get(root)?.set(id, kind);
  });
}

export function deleteNeed(root: string, key: NeedKey, full: string): Promise<void> {
  return locked(full, async () => {
    const s = await settingsOrFail(root);
    const raw = await readOrNull(full);
    if (raw == null) return;
    const { text, crlf } = decodeText(raw);
    const out = removeNeed(text, key, s.config, s.declared);
    if (out !== text) await writeAtomic(full, encodeText(out, crlf));
  });
}

// ---- git, per need ----------------------------------------------------------------------

// Each need in a version of a file, by the part of its path after #.
function needsIn(root: string, s: Sphinx, path: string, raw: string | null): { file: NeedFile; texts: Map<string, string> } {
  const file = readNeedFile(path, decodeText(raw ?? '').text, s.config, s.declared);
  const ctx = needContext(root, s, file);
  const paths = needPaths(file);
  return { file, texts: new Map(file.needs.map((n, i) => [paths[i].slice(paths[i].lastIndexOf('#') + 1), needToItemText(n, ctx)])) };
}

export async function showNeed(root: string, commit: string, key: NeedKey): Promise<string | null> {
  const s = await sphinxSettings(root);
  const raw = await git.show(root, commit, key.file);
  if (!s || raw == null) return null;
  const file = readNeedFile(key.file, decodeText(raw).text, s.config, s.declared);
  return needText(file, key, needContext(root, s, file));
}

// The commits that changed the need (not just its file), newest first.
export async function needLog(root: string, key: NeedKey): Promise<FileCommit[]> {
  const s = await sphinxSettings(root);
  if (!s) return [];
  const log = await git.log(root, key.file);
  const versions = await git.versions(
    root,
    log.map((l) => `${l.commit}:${l.path}`),
  );
  const own = needPath(key.file, key.id, key.n);
  const texts = log.map((l, i) => needsIn(root, s, l.path, versions[i]).texts.get(own.slice(own.lastIndexOf('#') + 1)) ?? null);
  return log.flatMap((l, i) => (texts[i] != null && texts[i] !== texts[i + 1] ? [{ ...l, path: needPath(l.path, key.id, key.n) }] : []));
}

// Who last changed each line of the need: its text line by line, and its fields as the
// latest change to the directive's opening and options.
export async function needBlame(root: string, key: NeedKey): Promise<Blame | null> {
  const s = await sphinxSettings(root);
  const b = await git.blame(root, key.file);
  if (!s || !b) return null;
  const text = b.lines.map((l) => l.text).join('\n');
  const file = readNeedFile(key.file, text, s.config, s.declared);
  const paths = needPaths(file);
  const i = paths.indexOf(needPath(key.file, key.id, key.n));
  if (i < 0) return null;
  const need = file.needs[i];
  const item = needToItemText(need, needContext(root, s, file));
  const head = item.split('\n').length - 1 - (need.body ? need.body.split('\n').length : 0);
  const first = text.slice(0, need.start).split('\n').length - 1;
  const fields = b.lines.slice(first, need.bodyLine);
  const newest = fields.some((l) => !l.commit) ? null : (fields.map((l) => l.commit!).sort((x, y) => (b.commits[y]?.date ?? '').localeCompare(b.commits[x]?.date ?? ''))[0] ?? null);
  const body = need.body ? b.lines.slice(need.bodyLine, need.bodyLine + need.body.split('\n').length) : [];
  const lines = [...item.split('\n').slice(0, head).map((t) => ({ commit: newest, text: t })), ...body];
  return { lines, commits: b.commits };
}

// Changes to MyST files as changes to their needs (and to the page around them, when
// that changed too).
export async function needStatus(root: string, status: GitStatus): Promise<GitStatus> {
  const s = await sphinxSettings(root);
  if (!s) return status;
  const changes: GitChange[] = [];
  for (const c of status.changes) {
    if (c.kind === 'conflicted' || !/\.md$/i.test(c.path)) {
      changes.push(c);
      continue;
    }
    const now = c.kind === 'deleted' ? null : await readOrNull(join(root, c.path));
    const before = c.kind === 'added' || !status.head ? null : await git.show(root, status.head, c.from ?? c.path);
    if (!(now != null && mayHoldNeeds(now)) && !(before != null && mayHoldNeeds(before))) {
      changes.push(c);
      continue;
    }
    const a = needsIn(root, s, c.from ?? c.path, before);
    const b = needsIn(root, s, c.path, now);
    if (!a.file.needs.length && !b.file.needs.length) {
      changes.push(c);
      continue;
    }
    for (const k of new Set([...a.texts.keys(), ...b.texts.keys()])) {
      const was = a.texts.get(k);
      const is = b.texts.get(k);
      const path = `${c.path}#${k}`;
      if (was == null) changes.push({ path, kind: 'added' });
      else if (is == null) changes.push({ path: `${c.from ?? c.path}#${k}`, kind: 'deleted' });
      else if (was !== is) changes.push({ path, kind: 'modified' });
    }
    // The page around the needs changed, or the file moved: that's a change to the file.
    if (c.kind === 'renamed' || withoutNeeds(decodeText(before ?? '').text, a.file) !== withoutNeeds(decodeText(now ?? '').text, b.file)) changes.push(c);
  }
  return { ...status, changes };
}
