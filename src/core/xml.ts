// A small XML reader: elements, attributes, text and CDATA, enough for ReqIF and the
// XHTML inside it. No DTDs, no external entities (nothing is ever fetched).

export interface XmlElement {
  type: 'el';
  name: string; // as written, with any prefix: xhtml:div
  local: string; // without the prefix: div
  attrs: Record<string, string>;
  children: XmlNode[];
}

export interface XmlText {
  type: 'text';
  text: string;
}

export type XmlNode = XmlElement | XmlText;

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export class XmlError extends Error {}

export function parseXml(src: string): XmlElement {
  const root: XmlElement = { type: 'el', name: '#document', local: '#document', attrs: {}, children: [] };
  const stack: XmlElement[] = [root];
  let i = src.charCodeAt(0) === 0xfeff ? 1 : 0;
  const line = (at: number) => src.slice(0, at).split('\n').length;
  const fail = (msg: string, at: number): never => {
    throw new XmlError(`${msg} (line ${line(at)})`);
  };
  const name = /[A-Za-z_][\w.:-]*/y;
  const attr = /\s*([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/y;

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    const top = stack[stack.length - 1];
    if (lt < 0 || lt > i) {
      const text = src.slice(i, lt < 0 ? src.length : lt);
      if (stack.length > 1) top.children.push({ type: 'text', text: decodeEntities(text) });
      if (lt < 0) break;
      i = lt;
    }
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      if (end < 0) fail('A comment never ends', i);
      i = end + 3;
    } else if (src.startsWith('<![CDATA[', i)) {
      const end = src.indexOf(']]>', i + 9);
      if (end < 0) fail('A CDATA section never ends', i);
      top.children.push({ type: 'text', text: src.slice(i + 9, end) });
      i = end + 3;
    } else if (src.startsWith('<?', i)) {
      const end = src.indexOf('?>', i + 2);
      if (end < 0) fail('A processing instruction never ends', i);
      i = end + 2;
    } else if (src.startsWith('<!', i)) {
      // <!DOCTYPE …>, possibly with an internal subset in [ ]; skipped, never used.
      let depth = 0;
      let j = i + 2;
      for (; j < src.length; j++) {
        const c = src[j];
        if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '>' && depth <= 0) break;
      }
      i = j + 1;
    } else if (src[i + 1] === '/') {
      name.lastIndex = i + 2;
      const m = name.exec(src);
      if (!m) fail('A closing tag has no name', i);
      const end = src.indexOf('>', i);
      if (end < 0) fail('A closing tag never ends', i);
      const open = stack.pop();
      if (!open || open === root || open.name !== m![0]) fail(`</${m![0]}> closes <${open?.name ?? 'nothing'}>`, i);
      i = end + 1;
    } else {
      name.lastIndex = i + 1;
      const m = name.exec(src);
      if (!m) fail('A tag has no name', i);
      const el: XmlElement = { type: 'el', name: m![0], local: m![0].slice(m![0].indexOf(':') + 1), attrs: {}, children: [] };
      let j = name.lastIndex;
      for (;;) {
        attr.lastIndex = j;
        const a = attr.exec(src);
        if (!a) break;
        el.attrs[a[1]] = decodeEntities(a[3] ?? a[4] ?? '');
        j = attr.lastIndex;
      }
      while (j < src.length && /\s/.test(src[j])) j++;
      top.children.push(el);
      if (src[j] === '/' && src[j + 1] === '>') i = j + 2;
      else if (src[j] === '>') {
        stack.push(el);
        i = j + 1;
      } else fail(`<${el.name}> isn't closed properly`, i);
    }
  }
  if (stack.length > 1) fail(`<${stack[stack.length - 1].name}> is never closed`, src.length);
  const doc = root.children.find((c): c is XmlElement => c.type === 'el');
  if (!doc) throw new XmlError('There is no XML in the file.');
  return doc;
}

// ---- helpers ----

export const elements = (el: XmlElement | undefined, local?: string): XmlElement[] =>
  (el?.children ?? []).filter((c): c is XmlElement => c.type === 'el' && (!local || c.local === local));

export const child = (el: XmlElement | undefined, local: string): XmlElement | undefined => elements(el, local)[0];

// The first descendant with this local name, depth first.
export function find(el: XmlElement | undefined, local: string): XmlElement | undefined {
  if (!el) return undefined;
  for (const c of elements(el)) {
    if (c.local === local) return c;
    const f = find(c, local);
    if (f) return f;
  }
  return undefined;
}

export function textOf(node: XmlNode | undefined): string {
  if (!node) return '';
  if (node.type === 'text') return node.text;
  return node.children.map(textOf).join('');
}
