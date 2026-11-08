// What changed in the requirements and test cases between two versions of the
// repository (two releases, a release and now…): what was added, removed and changed,
// with the changed fields and text. Items are matched by ID, so a moved file is the
// same item.
import MarkdownIt from 'markdown-it';
import { blockChanges, blockText, bodyBlocks, fieldChanges, wordDiff, type FieldChange } from './diff';
import { DEFAULT_CONFIG, type Kind, type TypeDef } from './config';
import { compareIds, type Item, type ProjectIndex } from './model';
import { DOC_CSS, esc } from './report';

export type ChangeKind = 'added' | 'removed' | 'changed';

export interface ItemChange {
  id: string;
  kind: Kind;
  change: ChangeKind;
  old: Item | null;
  now: Item | null; // the item in the newer version
  fields: FieldChange[];
  textChanged: boolean;
  // Requirements: the test cases that verify it (in the newer version), and whether each
  // changed too. A requirement whose text changed while its tests didn't needs a look.
  tests: { id: string; changed: boolean }[];
}

const kindOrder = (k: Kind) => (k === 'requirement' ? 0 : k === 'testcase' ? 1 : 2);
const CHANGE_ORDER: Record<ChangeKind, number> = { added: 0, changed: 1, removed: 2 };

const sameText = (a: string, b: string) => {
  const ka = bodyBlocks(a).map((x) => x.key);
  const kb = bodyBlocks(b).map((x) => x.key);
  return ka.length === kb.length && ka.every((k, i) => k === kb[i]);
};

// The fields compared: not the review fingerprints (they change with any requirement
// edit and say nothing on their own) and not the path.
const fieldsOf = (it: Item) => {
  const { reviewed: _r, ...rest } = it.data;
  return rest;
};

export function compareVersions(old: ProjectIndex, now: ProjectIndex): ItemChange[] {
  const out: ItemChange[] = [];
  for (const it of now.items) {
    const was = old.byId.get(it.id);
    if (!was) {
      out.push({ id: it.id, kind: it.kind, change: 'added', old: null, now: it, fields: [], textChanged: false, tests: [] });
      continue;
    }
    const fields = fieldChanges(fieldsOf(was), fieldsOf(it));
    const textChanged = !sameText(was.body, it.body);
    if (fields.length || textChanged) out.push({ id: it.id, kind: it.kind, change: 'changed', old: was, now: it, fields, textChanged, tests: [] });
  }
  for (const was of old.items)
    if (!now.byId.has(was.id)) out.push({ id: was.id, kind: was.kind, change: 'removed', old: was, now: null, fields: [], textChanged: false, tests: [] });

  const touched = new Set(out.map((c) => c.id));
  for (const c of out)
    if (c.kind === 'requirement' && c.now) c.tests = (now.verifiedBy.get(c.id) ?? []).map((t) => ({ id: t.id, changed: touched.has(t.id) }));

  return out.sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind) || a.kind.localeCompare(b.kind) || CHANGE_ORDER[a.change] - CHANGE_ORDER[b.change] || compareIds(a.id, b.id));
}

export interface ChangeCounts {
  added: number;
  changed: number;
  removed: number;
}

export function changeCounts(changes: ItemChange[], kind: Kind): ChangeCounts {
  const of = (k: ChangeKind) => changes.filter((c) => c.kind === kind && c.change === k).length;
  return { added: of('added'), changed: of('changed'), removed: of('removed') };
}

// Requirements whose text changed while none of their test cases did: the tests may no
// longer match.
export const untouchedTests = (c: ItemChange) => c.kind === 'requirement' && c.change === 'changed' && c.textChanged && c.tests.length > 0 && c.tests.every((t) => !t.changed);

// "2 added, 3 changed, 1 removed"
export function countsText(c: ChangeCounts): string {
  const parts = (['added', 'changed', 'removed'] as const).filter((k) => c[k]).map((k) => `${c[k]} ${k}`);
  return parts.length ? parts.join(', ') : 'no changes';
}

// ---- as a document (HTML to print or save as PDF) ----

const md = MarkdownIt('commonmark', { html: false }).enable(['table', 'strikethrough']);

export interface ChangesDocOptions {
  title: string;
  from: string; // "Release v2.3.0 (requirements at 1a2b3c4)"
  to: string;
  meta: [string, string][];
  image: (itemPath: string, src: string) => string;
  types?: TypeDef[]; // the item types, for headings (default: requirements and test cases)
}

// The item types with changes, in the project's order, then any it doesn't know.
export function changedTypes(changes: ItemChange[], types: Pick<TypeDef, 'key' | 'plural'>[] = DEFAULT_CONFIG.types): { key: Kind; plural: string }[] {
  const kinds = [...new Set(changes.map((c) => c.kind))];
  const known = types.filter((t) => kinds.includes(t.key));
  return [...known, ...kinds.filter((k) => !types.some((t) => t.key === k)).map((k) => ({ key: k, plural: k }))];
}

function renderBlock(md_: string, path: string, image: ChangesDocOptions['image']) {
  return md
    .render(md_)
    .replace(/<img src="([^"]*)"/g, (_m, src: string) => `<img src="${esc(/^(https?:|data:)/.test(src) ? src : image(path, src.replace(/&amp;/g, '&')))}"`);
}

function textDiffHtml(oldBody: string, newBody: string, path: string, image: ChangesDocOptions['image']): string {
  const a = bodyBlocks(oldBody).map((b) => b.key);
  const b = bodyBlocks(newBody).map((x) => x.key);
  const out: string[] = [];
  let skipped = 0;
  const flush = () => {
    if (skipped) out.push(`<p class="skipped">${skipped} unchanged paragraph${skipped === 1 ? '' : 's'}</p>`);
    skipped = 0;
  };
  for (const op of blockChanges(a, b)) {
    if (op.kind === 'same') {
      skipped++;
      continue;
    }
    flush();
    if (op.kind === 'added') out.push(`<div class="blk add">${renderBlock(b[op.b], path, image)}</div>`);
    else if (op.kind === 'removed') out.push(`<div class="blk del">${renderBlock(a[op.a], path, image)}</div>`);
    else
      out.push(
        `<div class="blk chg">${wordDiff(blockText(a[op.a]), blockText(b[op.b]))
          .map((p) => (p.kind === 'same' ? esc(p.text) : p.kind === 'add' ? `<ins>${esc(p.text)}</ins>` : `<del>${esc(p.text)}</del>`))
          .join('')}</div>`,
      );
  }
  flush();
  return out.join('\n');
}

const LABEL: Record<ChangeKind, string> = { added: 'Added', changed: 'Changed', removed: 'Removed' };

function itemHtml(c: ItemChange, o: ChangesDocOptions): string {
  const it = c.now ?? c.old!;
  const head = `<h3><span class="mono">${esc(c.id)}</span> ${esc(it.title)} <span class="pill ${c.change}">${LABEL[c.change]}</span></h3>`;
  const parts: string[] = [head];
  if (c.change === 'changed') {
    if (c.fields.length)
      parts.push(
        `<table class="fields">${c.fields
          .map((f) => `<tr><td>${esc(f.label)}</td><td>${f.old ? `<del>${esc(f.old)}</del>` : '<span class="muted">(none)</span>'} → ${f.new ? `<ins>${esc(f.new)}</ins>` : '<span class="muted">(none)</span>'}</td></tr>`)
          .join('')}</table>`,
      );
    if (c.textChanged) parts.push(`<div class="diff">${textDiffHtml(c.old!.body, c.now!.body, c.now!.path, o.image)}</div>`);
    else parts.push('<p class="muted small">The text is the same.</p>');
  } else if (c.change === 'added') parts.push(`<div class="prose">${renderBlock(c.now!.body, c.now!.path, o.image)}</div>`);
  else parts.push(`<p class="muted small">Removed. Last status: ${esc(c.old!.status || 'none')}.</p>`);
  if (c.kind === 'requirement' && c.tests.length)
    parts.push(
      `<p class="small">Verified by ${c.tests.map((t) => `<span class="mono">${esc(t.id)}</span>${t.changed ? ' (changed too)' : ''}`).join(', ')}${untouchedTests(c) ? ' <span class="pill warn">tests not updated</span>' : ''}</p>`,
    );
  return `<section class="item">${parts.join('\n')}</section>`;
}

export function changesHtml(changes: ItemChange[], o: ChangesDocOptions, generated = new Date()): string {
  const reqs = changes.filter((c) => c.kind === 'requirement');
  const types = o.types ?? DEFAULT_CONFIG.types;
  // Requirements and test cases always get a line; other types when they changed.
  const rows = [...types.filter((t) => t.builtIn), ...changedTypes(changes, types).filter((t) => t.key !== 'requirement' && t.key !== 'testcase')];
  const stale = reqs.filter(untouchedTests);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)}</title>
<style>${DOC_CSS}
h3{font-size:16px;margin:0 0 8px}
.item{padding:16px 0 12px;border-bottom:1px solid var(--line);break-inside:avoid-page}
.fields{width:auto;margin:0 0 10px}.fields td{padding:2px 14px 2px 0;border:0;font-size:13px}.fields td:first-child{color:var(--muted)}
ins{background:#dff3ec;color:#0b5a48;text-decoration:none}del{background:#fbe3d8;color:#8a2c10}
.blk{margin:6px 0;padding:2px 10px;border-left:3px solid transparent;font-size:14px}.blk>:first-child{margin-top:0}.blk>:last-child{margin-bottom:0}
.blk.add{border-color:#127a63;background:#f1faf6}.blk.del{border-color:#cc4a26;background:#fdf3ef;text-decoration:line-through;color:#6b3a2a}.blk.chg{border-color:#b88f17}
.skipped{color:var(--muted);font-size:12px;margin:4px 0}
.prose{font-size:14px}.prose img,.blk img{max-width:100%}
.prose :is(h1,h2,h3,h4,h5,h6),.blk :is(h1,h2,h3,h4,h5,h6){font-size:14px;margin:10px 0 4px;padding:0;border:0}
.pill.added{background:var(--okbg);color:var(--ok)}.pill.changed{background:#fff4cc;color:var(--warn)}.pill.removed{background:var(--badbg);color:var(--bad)}.pill.warn{background:var(--badbg);color:var(--bad)}
.small{font-size:12.5px}
.counts td,.counts th{text-align:right}.counts td:first-child,.counts th:first-child{text-align:left}
</style></head><body><main>
<h1>${esc(o.title)}</h1>
<table class="meta">${[['From', o.from], ['To', o.to], ...o.meta, ['Generated', generated.toLocaleString()] as [string, string]].map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>
<h2>Summary</h2>
<table class="counts"><tr><th></th><th>Added</th><th>Changed</th><th>Removed</th></tr>
${rows
  .map((t) => {
    const c = changeCounts(changes, t.key);
    return `<tr><td>${esc(t.plural)}</td><td>${c.added}</td><td>${c.changed}</td><td>${c.removed}</td></tr>`;
  })
  .join('\n')}</table>
${stale.length ? `<p>${stale.length} requirement${stale.length === 1 ? '' : 's'} changed text while ${stale.length === 1 ? 'its' : 'their'} test cases didn’t: ${stale.map((c) => `<span class="mono">${esc(c.id)}</span>`).join(', ')}.</p>` : ''}
${!changes.length ? '<p>Nothing changed in the requirements or test cases.</p>' : ''}
${changedTypes(changes, types)
  .map((t) => `<h2>${esc(t.plural)}</h2>${changes.filter((c) => c.kind === t.key).map((c) => itemHtml(c, o)).join('\n')}`)
  .join('\n')}
</main></body></html>
`;
}
