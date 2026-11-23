// Renaming an item's ID, and everything that names it: test cases' `verifies:`,
// requirements' `refines:`, review fingerprints, mentions in text and fields, and test
// runs' results. Optionally the file too, when it's named after the ID. Pure: the app
// writes what it gives.
import { decodeText, encodeText, joinFrontMatter, setFields, splitFrontMatter } from './frontmatter';
import { buildIndex, fingerprint, linkState, type Item, type ProjectIndex, type SourceFile } from './model';
import { isNeedPath } from './myst';

export interface RenamePlan {
  texts: Map<string, string>; // path (as it is now) → its new text; only files that change
  move: { from: string; to: string } | null; // the item's file, renamed
  // What changes, for the dialog: other items naming it, and test runs with its results.
  items: Item[];
  runs: string[];
  duplicate: boolean; // another file has the same ID: only this one's ID changes
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The ID as a whole word: not part of a longer ID (REQ-07 in REQ-070, REQ-07.1), a file
// name (images/REQ-07.png) or a path.
export function idPattern(id: string): RegExp {
  return new RegExp(`(?<![\\w./-])${escape(id)}(?![\\w-]|\\.\\w)`, 'g');
}

// Where the file goes when it's named after the ID: requirements/REQ-07-retry.md →
// requirements/REQ-7-retry.md. null: it isn't.
export function movedPath(path: string, oldId: string, newId: string, taken: (p: string) => boolean): string | null {
  if (isNeedPath(path)) return null; // a Sphinx need: its path follows its ID by itself
  const slash = path.lastIndexOf('/') + 1;
  const name = path.slice(slash);
  if (!name.startsWith(oldId) || !/^(-|\.md$)/i.test(name.slice(oldId.length))) return null;
  const base = path.slice(0, slash) + newId + name.slice(oldId.length).replace(/\.md$/i, '');
  let to = `${base}.md`;
  for (let n = 2; taken(to); n++) to = `${base}-${n}.md`;
  return to;
}

export function planRename(index: ProjectIndex, texts: Map<string, string>, configText: string | null, item: Item, newId: string, moveFile: boolean): RenamePlan {
  const oldId = item.id;
  const duplicate = index.items.filter((i) => i.id === oldId).length > 1;
  const out = new Map<string, string>();
  const edit = (path: string, change: (text: string) => string) => {
    const before = out.get(path) ?? texts.get(path);
    if (before == null) return;
    const after = change(before);
    if (after !== before) out.set(path, after);
  };
  const setFront = (path: string, changes: Record<string, unknown>) =>
    edit(path, (raw) => {
      const { text, crlf } = decodeText(raw);
      const { front, body } = splitFrontMatter(text);
      return encodeText(joinFrontMatter(setFields(front, changes), body), crlf);
    });

  // Two files with the same ID: what names it can't tell them apart, so only this
  // file's ID changes (the usual way out of a duplicate).
  if (duplicate) {
    setFront(item.path, { id: newId });
  } else {
    const re = idPattern(oldId);
    for (const path of texts.keys()) edit(path, (t) => t.replace(re, newId));
  }

  let move: RenamePlan['move'] = null;
  if (moveFile) {
    const to = movedPath(item.path, oldId, newId, (p) => texts.has(p) && p !== item.path);
    if (to && to !== item.path) {
      move = { from: item.path, to };
      // Links to the file by name (a Markdown link from another item).
      const from = item.path.slice(item.path.lastIndexOf('/') + 1);
      const name = to.slice(to.lastIndexOf('/') + 1);
      const re = new RegExp(`(?<![\\w.-])${escape(from)}`, 'g');
      for (const path of texts.keys()) edit(path, (t) => t.replace(re, name));
    }
  }

  // Text that mentions the ID changes, and with it the review fingerprint of a
  // requirement it's in. A link that was reviewed stays reviewed: renaming isn't a change
  // to review.
  if (!duplicate && out.size) {
    const files = (m: Map<string, string>): SourceFile[] => [...m].map(([path, text]) => ({ path, text }));
    const after = buildIndex(files(new Map([...texts, ...out])), configText);
    const renamed = (id: string) => (id === oldId ? newId : id);
    for (const was of index.items) {
      const now = after.byPath.get(was.path);
      if (!now) continue;
      const reviewed = { ...now.reviewed };
      let changed = false;
      for (const k of Object.keys(was.reviewed)) {
        const target = index.byId.get(k);
        const newTarget = after.byId.get(renamed(k));
        if (!target || !newTarget || linkState(was, target) !== 'ok') continue;
        const fp = fingerprint(newTarget);
        if (reviewed[renamed(k)] !== fp) {
          reviewed[renamed(k)] = fp;
          changed = true;
        }
      }
      if (changed) setFront(was.path, { reviewed });
    }
  }

  const runsDir = index.config.runs.dir;
  return {
    texts: out,
    move,
    items: index.items.filter((i) => i !== item && out.has(i.path)),
    runs: [...out.keys()].filter((p) => p.startsWith(runsDir + '/') && /\.ya?ml$/i.test(p)),
    duplicate,
  };
}
