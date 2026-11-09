// A DOORS module exported as HTML (File → Export → HTML), read into the same shape as a
// ReqIF export, so the DOORS import (doors.ts) takes it from there: the map, headings,
// pictures, statuses, links and the report work the same.
//
// The export is the module's view as a table: a header row naming the columns, then one
// row per object. What the columns are is worked out from their names and contents:
//
// - the ID: a column named Absolute Number, Object Identifier, ID…, or else one of unique
//   numbers or IDs;
// - heading and text: columns named Object Heading and Object Text, or else the main column
//   (the one with the most text), whose cells are headings ("2.1 Payment" in bold or as an
//   <h2>) or text;
// - links: a column named like one (Out-links, Verifies, Satisfies…, as Analysis → Wizard
//   makes them) whose cells name other objects, by ID or Absolute Number, optionally with
//   the module's name (needed when the numbers alone are ambiguous);
// - the depth: an Object Level column when there is one, else heading numbers (2.1 is
//   level 2), with objects under the heading above them;
// - the rest are attributes: rich text, numbers, or values from a short list.
//
// Several files: each is a module, named by its <title> (or file name); files with the
// same title are one module, in order. Links between modules read together come across.
import type { XmlElement, XmlNode } from './xml';
import { allElements, parseHtml, tableRows, textLines } from './html';
import type { Reqif, ReqifNode, ReqifObject, ReqifValue } from './reqif';

export interface HtmlExportFile {
  name: string; // shown in messages: the file name
  html: string;
  key: string; // pictures' paths start with it, to tell the files apart: f0, f1…
}

export interface HtmlExport {
  reqif: Reqif;
  embedded: Map<string, Uint8Array>; // pictures written into the HTML (data: URLs), by path
  notes: string[]; // what was found, for the person running the import
}

const ID_HEADER = /^(absolute ?number|abs\.? ?no\.?|object ?identifier|object ?id|identifier|id|req\.? ?id|requirement ?id|key)$/i;
const LINK_HEADER = /link|verif|satisf|refin|trace|test|cover|deriv|parent|child|implement|realiz|allocat|depend|relat/i;
const LEVEL_HEADER = /^(object )?level$/i;
const RICH = new Set(['img', 'object', 'table', 'ul', 'ol', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'sub', 'sup', 'pre', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const HEADING_NUMBER = /^(\d+(?:\.\d+)*)\.?\s+(?=\S)/;
const OBJECT_NUMBER = /^\d+(?:\.\d+)*-\d+\s+/; // 2.1-3: an object's number, when shown

interface Row {
  key: string; // the object's key: m0:5
  cells: XmlElement[];
}

interface Module {
  name: string;
  files: string[];
  header: string[];
  rows: Row[];
}

const hasTag = (nodes: XmlNode[], tags: Set<string>): boolean => nodes.some((n) => n.type === 'el' && (tags.has(n.local) || hasTag(n.children, tags)));
const single = (s: string) => s.replace(/\s+/g, ' ').trim();
const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

// Meaningful children: no whitespace-only text, no empty inline wrappers.
function content(nodes: XmlNode[]): XmlNode[] {
  return nodes.filter((n) => (n.type === 'text' ? n.text.trim() !== '' : n.local === 'img' || n.local === 'object' || n.local === 'br' || textLines([n]) !== '' || hasTag([n], new Set(['img', 'object']))));
}

// Unwraps a cell down to its only child while that's a wrapper (div, p, span, font).
function unwrap(nodes: XmlNode[]): XmlNode[] {
  let ns = content(nodes);
  while (ns.length === 1 && ns[0].type === 'el' && ['div', 'p', 'span', 'font', 'a', 'center'].includes(ns[0].local)) ns = content(ns[0].children);
  return ns;
}

const isBold = (e: XmlElement) => e.local === 'b' || e.local === 'strong' || /font-weight\s*:\s*(bold|[6-9]00)/i.test(e.attrs.style ?? '') || /^h[1-6]$/.test(e.local);

// Is all the text of these nodes inside bold or heading elements?
function allBold(nodes: XmlNode[], bold = false): boolean {
  return nodes.every((n) => (n.type === 'text' ? bold || !n.text.trim() : n.local === 'br' ? true : allBold(n.children, bold || isBold(n))));
}

// A main-column cell: a heading (its text and level), text, or a heading followed by text.
function splitMain(cell: XmlElement): { heading: string; level: number; text: XmlNode[] } {
  const nodes = unwrap(cell.children);
  const first = nodes[0];
  const levelOf = (t: string, fallback: number) => {
    const m = HEADING_NUMBER.exec(t);
    return m ? m[1].split('.').length : fallback;
  };
  const strip = (t: string) => single(t.replace(HEADING_NUMBER, ''));
  // <h2>2.1 Payment</h2>, possibly followed by text.
  if (first?.type === 'el' && /^h[1-6]$/.test(first.local)) {
    const t = single(textLines([first]));
    return { heading: strip(t), level: levelOf(t, Number(first.local[1])), text: nodes.slice(1) };
  }
  const all = single(textLines(nodes));
  const oneLine = !textLines(nodes).includes('\n');
  // Bold and short on one line, or numbered like a heading (2.1 Payment), without a full stop.
  const numbered = /^\d+(\.\d+)+\s+\S|^\d+\.\s+\S/.test(all);
  if (all && oneLine && all.length <= 150 && !hasTag(nodes, new Set(['img', 'object', 'table'])) && !/[.:;]$/.test(all) && (allBold(nodes) || numbered))
    return { heading: strip(all), level: levelOf(all, 1), text: [] };
  // A bold first line that is a numbered heading, then text below it.
  if (first?.type === 'el' && isBold(first) && HEADING_NUMBER.test(single(textLines([first])))) {
    const t = single(textLines([first]));
    return { heading: strip(t), level: levelOf(t, 1), text: nodes.slice(1) };
  }
  return { heading: '', level: 0, text: dropObjectNumber(nodes) };
}

// "2.1-3 The system shall…": the object number DOORS can show before the text goes.
function dropObjectNumber(nodes: XmlNode[]): XmlNode[] {
  const firstText = (ns: XmlNode[]): { text: string } | null => {
    for (const n of ns) {
      if (n.type === 'text') return n.text.trim() ? n : null;
      const f = firstText(n.children);
      if (f) return f;
    }
    return null;
  };
  const t = firstText(nodes);
  if (t && OBJECT_NUMBER.test(t.text.trimStart())) t.text = t.text.trimStart().replace(OBJECT_NUMBER, '');
  return nodes;
}

// Pictures: paths made relative to the file's key; data: URLs kept as embedded files.
function rewritePictures(nodes: XmlNode[], key: string, embedded: Map<string, Uint8Array>) {
  for (const n of nodes) {
    if (n.type !== 'el') continue;
    const attr = n.local === 'img' ? 'src' : n.local === 'object' ? 'data' : null;
    const v = attr ? n.attrs[attr] : undefined;
    if (attr && v) {
      const data = /^data:([\w/+.-]+)?(;base64)?,(.*)$/s.exec(v);
      if (data) {
        const ext = (data[1] ?? 'image/png').split('/')[1]?.replace('jpeg', 'jpg').replace('svg+xml', 'svg') ?? 'png';
        const path = `${key}/embedded-${embedded.size + 1}.${ext}`;
        embedded.set(path, data[2] ? Uint8Array.from(atob(data[3]), (c) => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(data[3])));
        n.attrs[attr] = path;
        if (n.local === 'object' && !n.attrs.type) n.attrs.type = data[1] ?? 'image/png';
      } else if (!/^[a-z][\w+.-]*:/i.test(v) || /^file:/i.test(v)) {
        // A path beside the file (pics/a.png, ..\pics\a.png, file:///…/a.png: its name).
        const rel = /^file:/i.test(v) ? v.replace(/^.*[\\/]/, '') : v.replace(/\\/g, '/').replace(/^\.\//, '');
        n.attrs[attr] = `${key}/${rel}`;
      }
    }
    rewritePictures(n.children, key, embedded);
  }
}

// The biggest table in the file: the module's view.
function moduleTable(doc: XmlElement): XmlElement[][] | null {
  let best: XmlElement[][] | null = null;
  for (const t of allElements(doc, 'table')) {
    const rows = tableRows(t).filter((r) => r.length);
    if (rows.length >= 2 && (!best || rows.length > best.length)) best = rows;
  }
  return best;
}

export function readDoorsHtml(files: HtmlExportFile[]): HtmlExport {
  const reqif: Reqif = { title: '', objects: new Map(), relations: [], specs: [], objectBase: new Map() };
  const embedded = new Map<string, Uint8Array>();
  const notes: string[] = [];
  const modules: Module[] = [];

  for (const f of files) {
    const { doc, title } = parseHtml(f.html);
    const rows = moduleTable(doc);
    if (!rows)
      throw new Error(
        `${f.name}: there's no table in it. Export the module from a view with columns (at least Absolute Number and the main column), so DOORS writes it as a table.`,
      );
    rewritePictures([doc], f.key, embedded);
    const fileName = f.name.replace(/^.*[\\/]/, '').replace(/\.html?$/i, '');
    const name = single(title).split(/[\\/]/).filter(Boolean).pop() || fileName;
    reqif.title ||= single(title) || fileName;
    const header = rows[0].map((c, k) => single(textLines(c.children)) || `Column ${k + 1}`);
    // Repeated names get a number: two "Out-links" columns stay apart.
    header.forEach((h, k) => {
      const before = header.slice(0, k).filter((x) => x === h).length;
      if (before) header[k] = `${h} (${before + 1})`;
    });
    const headerText = header.join('\u0000');
    let m = modules.find((x) => x.name === name);
    if (m && m.header.join('\u0000') !== headerText) {
      notes.push(`${f.name}: titled “${name}” like an earlier file, but its columns differ: read as a module of its own.`);
      m = undefined;
    }
    if (!m) {
      m = { name: modules.some((x) => x.name === name) ? `${name} (${f.name})` : name, files: [], header, rows: [] };
      modules.push(m);
    }
    m.files.push(f.name.replace(/^.*[\\/]/, ''));
    const mi = modules.indexOf(m);
    for (const cells of rows.slice(1)) {
      // A header row repeated (at page breaks) isn't an object.
      if (cells.map((c) => single(textLines(c.children))).join('\u0000') === headerText) continue;
      m.rows.push({ key: `m${mi}:${m.rows.length}`, cells });
    }
  }

  // ---- what each column is ------------------------------------------------------------
  interface Plan {
    id: number;
    heading: number; // a column holding headings only (Object Heading), or -1
    text: number; // Object Text, or the main column (headings and text), or -1
    main: boolean; // text is the main column: split into headings and text
    level: number;
    links: Set<number>;
  }
  const cellText = (r: Row, k: number) => (r.cells[k] ? textLines(r.cells[k].children) : '');
  const plans: Plan[] = modules.map((m) => {
    const cols = m.header.map((_, k) => k);
    let id = cols.find((k) => ID_HEADER.test(m.header[k])) ?? -1;
    if (id < 0)
      id =
        cols.find((k) => {
          const vals = m.rows.map((r) => single(cellText(r, k))).filter(Boolean);
          return vals.length >= m.rows.length * 0.8 && new Set(vals).size === vals.length && vals.every((v) => /^[A-Za-z]*[-_]?\d+$/.test(v));
        }) ?? -1;
    const heading = cols.find((k) => /^object heading$/i.test(m.header[k])) ?? -1;
    let text = cols.find((k) => /^object text$/i.test(m.header[k])) ?? -1;
    const level = cols.find((k) => LEVEL_HEADER.test(m.header[k])) ?? -1;
    let main = false;
    if (heading < 0 && text < 0) {
      // The main column: the most text, not the ID.
      const size = (k: number) => m.rows.reduce((n, r) => n + cellText(r, k).length, 0);
      text = cols.filter((k) => k !== id && k !== level).sort((a, b) => size(b) - size(a))[0] ?? -1;
      main = text >= 0;
    }
    return { id, heading, text, main, level, links: new Set<number>() };
  });

  // ---- the objects' IDs, to find what links name ---------------------------------------
  const idText = new Map<string, string>(); // object key → its ID as shown
  const byId = new Map<string, string[]>(); // ID (lower case) → object keys
  const byNumber = new Map<string, string[]>(); // trailing number → object keys
  const moduleOf = (key: string) => Number(key.slice(1, key.indexOf(':')));
  modules.forEach((m, mi) => {
    const p = plans[mi];
    if (p.id < 0) return;
    for (const r of m.rows) {
      const v = single(cellText(r, p.id));
      if (!v) continue;
      idText.set(r.key, v);
      (byId.get(v.toLowerCase()) ?? byId.set(v.toLowerCase(), []).get(v.toLowerCase())!).push(r.key);
      const n = /(\d+)$/.exec(v)?.[1];
      if (n) (byNumber.get(String(Number(n))) ?? byNumber.set(String(Number(n)), []).get(String(Number(n)))!).push(r.key);
    }
  });
  // Module names to look for in a link, longest first (so "Tests 2" wins over "Tests").
  const names = modules.map((m, mi) => ({ mi, name: m.name.toLowerCase() })).sort((a, b) => b.name.length - a.name.length);

  type Ref = { key: string } | { ambiguous: string } | null;
  const resolve = (line: string, own: number): Ref => {
    let rest = line.toLowerCase();
    let inModule = -1;
    for (const n of names)
      if (n.name && rest.includes(n.name)) {
        inModule = n.mi;
        rest = rest.replace(n.name, ' ');
        break;
      }
    const pick = (keys: string[] | undefined, what: string): Ref => {
      let ks = keys ?? [];
      if (inModule >= 0) ks = ks.filter((k) => moduleOf(k) === inModule);
      // Without a module named: another module's object before one of its own.
      else if (ks.length > 1 && ks.some((k) => moduleOf(k) !== own)) ks = ks.filter((k) => moduleOf(k) !== own);
      return ks.length === 1 ? { key: ks[0] } : ks.length > 1 ? { ambiguous: what } : null;
    };
    const id = /\b([a-z][a-z0-9_]*[-_]\d+)\b/.exec(rest);
    if (id) {
      const r = pick(byId.get(id[1]), id[1].toUpperCase());
      if (r) return r;
    }
    const num = /\b(\d+)\b/.exec(rest);
    return num ? pick(byNumber.get(String(Number(num[1]))), num[1]) : null;
  };

  // Link columns: named like links, or (named anything) naming objects by ID with letters.
  modules.forEach((m, mi) => {
    const p = plans[mi];
    m.header.forEach((h, k) => {
      if ([p.id, p.heading, p.text, p.level].includes(k)) return;
      const cells = m.rows.map((r) => cellText(r, k)).filter(Boolean);
      if (!cells.length) return;
      const lines = cells.map((c) => c.split('\n'));
      const ok = lines.filter((ls) => ls.some((l) => resolve(l, mi))).length;
      const lettered = cells.every((c) => c.split('\n').every((l) => /[a-z][a-z0-9_]*[-_]\d+/i.test(l)));
      if (ok && ok >= cells.length * 0.5 && (LINK_HEADER.test(h) || lettered)) p.links.add(k);
    });
  });

  // ---- objects, links and the module tree ----------------------------------------------
  modules.forEach((m, mi) => {
    const p = plans[mi];
    // Each column's kind: rich text, a number, a short list of values, or text.
    const kinds = m.header.map((_, k): ReqifValue['kind'] => {
      if (k === p.text) return 'xhtml';
      const cells = m.rows.map((r) => r.cells[k]).filter((c): c is XmlElement => !!c && !!textLines(c.children));
      if (cells.some((c) => hasTag(c.children, RICH))) return 'xhtml';
      const vals = cells.map((c) => single(textLines(c.children)));
      if (vals.length && vals.every((v) => /^-?\d+$/.test(v))) return 'integer';
      const distinct = new Set(cells.flatMap((c) => textLines(c.children).split('\n')));
      if (vals.length && distinct.size <= Math.max(2, Math.min(30, vals.length / 2)) && [...distinct].every((v) => v.length <= 40)) return 'enum';
      return 'string';
    });

    const spec = { id: `spec-${mi}`, name: m.name, children: [] as ReqifNode[], base: '' };
    reqif.specs.push(spec);
    const open: { node: ReqifNode; depth: number }[] = []; // headings above, by depth
    let headings = 0;
    let ambiguous = 0;
    let unresolved = 0;
    let links = 0;
    for (const r of m.rows) {
      const values = new Map<string, ReqifValue>();
      let heading = '';
      let headingLevel = 0;
      let text: XmlNode[] = [];
      if (p.main) {
        const s = r.cells[p.text] ? splitMain(r.cells[p.text]) : { heading: '', level: 0, text: [] };
        heading = s.heading;
        headingLevel = s.level;
        text = s.text;
      } else {
        if (p.heading >= 0) heading = single(cellText(r, p.heading));
        if (p.text >= 0 && r.cells[p.text]) text = dropObjectNumber(unwrap(r.cells[p.text].children));
        headingLevel = HEADING_NUMBER.test(heading) ? HEADING_NUMBER.exec(heading)![1].split('.').length : 1;
        heading = heading.replace(HEADING_NUMBER, '');
      }
      if (heading) values.set('Object Heading', { kind: 'string', text: heading });
      const plainText = textLines(text);
      if (plainText || hasTag(text, new Set(['img', 'object']))) values.set('Object Text', { kind: 'xhtml', text: single(plainText), xhtml: text });

      m.header.forEach((h, k) => {
        if (k === p.text || k === p.heading || p.links.has(k) || !r.cells[k]) return;
        const t = textLines(r.cells[k].children);
        if (!t) return;
        const kind = k === p.id ? 'string' : kinds[k];
        if (kind === 'xhtml') values.set(h, { kind, text: single(t), xhtml: unwrap(r.cells[k].children) });
        else if (kind === 'enum') values.set(h, { kind, text: t.split('\n').join(', '), enums: t.split('\n') });
        else values.set(h, { kind, text: kind === 'string' ? t : single(t) });
      });

      const isHeading = !!heading && !values.has('Object Text');
      const o: ReqifObject = { id: r.key, type: isHeading ? 'Heading' : '', lastChange: '', values };
      reqif.objects.set(r.key, o);
      reqif.objectBase.set(r.key, '');

      // Links named in this row.
      for (const k of p.links)
        for (const line of cellText(r, k).split('\n').filter(Boolean)) {
          const ref = resolve(line, mi);
          if (ref && 'key' in ref) {
            if (ref.key !== r.key && !reqif.relations.some((x) => x.source === r.key && x.target === ref.key && x.type === m.header[k])) {
              reqif.relations.push({ id: `${r.key}>${ref.key}:${k}`, type: m.header[k], source: r.key, target: ref.key });
              links++;
            }
          } else if (ref) ambiguous++;
          else unresolved++;
        }

      // Where it goes in the module.
      const levelValue = p.level >= 0 ? Number(single(cellText(r, p.level))) : NaN;
      const node: ReqifNode = { object: r.key, children: [] };
      if (Number.isInteger(levelValue) && levelValue > 0) {
        while (open.length && open[open.length - 1].depth >= levelValue) open.pop();
        (open.length ? open[open.length - 1].node.children : spec.children).push(node);
        open.push({ node, depth: levelValue });
      } else if (isHeading) {
        const depth = Math.max(1, headingLevel);
        while (open.length && open[open.length - 1].depth >= depth) open.pop();
        (open.length ? open[open.length - 1].node.children : spec.children).push(node);
        open.push({ node, depth });
      } else (open.length ? open[open.length - 1].node.children : spec.children).push(node);
      if (isHeading) headings++;
    }

    const role = (k: number) =>
      k === p.id ? 'the ID' : k === p.level ? 'the level' : k === p.heading ? 'headings' : k === p.text ? (p.main ? 'the main column: headings and text' : 'the text') : p.links.has(k) ? 'links' : kinds[k] === 'xhtml' ? 'an attribute (rich text)' : 'an attribute';
    notes.push(
      `${m.name} (${m.files.join(', ')}): ${count(m.rows.length, 'row')}, ${count(headings, 'heading')}, ${count(links, 'link')}.`,
      ...m.header.map((h, k) => `  “${h}”: ${role(k)}`),
    );
    if (p.id < 0) notes.push('  No ID column found: IDs will be made up, and links to this module can’t be found. Add Absolute Number to the view.');
    if (p.links.size === 0 && modules.length > 1) notes.push('  No link column found. Add one with Analysis → Wizard (show the linked objects’ Absolute Number).');
    if (ambiguous) notes.push(`  ${count(ambiguous, 'link')} name a number found in several modules: show the module name in the link column to tell them apart.`);
    if (unresolved) notes.push(`  ${count(unresolved, 'line')} in link columns name no object in the files read (another module? give its export too).`);
  });

  return { reqif, embedded, notes };
}
