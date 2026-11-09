// A forgiving HTML reader, for HTML as DOORS and other tools write it: tags in any case,
// attributes unquoted or without a value, elements left open (<p>, <li>, <td>, <tr>),
// void elements (<br>, <img>), stray closing tags. Gives the same tree as xml.ts, with
// lower-case names, so xhtmlToMarkdown reads it. Scripts and styles are left out.
import type { XmlElement, XmlNode } from './xml';

// Named character references: Latin-1 (160–255, in order) and the usual others.
const LATIN1 =
  'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml'.split(
    ' ',
  );
const NAMED: Record<string, number> = {
  ...Object.fromEntries(LATIN1.map((n, i) => [n, 160 + i])),
  quot: 34, amp: 38, apos: 39, lt: 60, gt: 62, OElig: 338, oelig: 339, Scaron: 352, scaron: 353, Yuml: 376, fnof: 402, circ: 710, tilde: 732,
  ensp: 8194, emsp: 8195, thinsp: 8201, zwnj: 8204, zwj: 8205, lrm: 8206, rlm: 8207, ndash: 8211, mdash: 8212, lsquo: 8216, rsquo: 8217, sbquo: 8218,
  ldquo: 8220, rdquo: 8221, bdquo: 8222, dagger: 8224, Dagger: 8225, bull: 8226, hellip: 8230, permil: 8240, prime: 8242, Prime: 8243, lsaquo: 8249,
  rsaquo: 8250, euro: 8364, trade: 8482, larr: 8592, uarr: 8593, rarr: 8594, darr: 8595, harr: 8596, rArr: 8658, hArr: 8660, minus: 8722, radic: 8730,
  infin: 8734, asymp: 8776, ne: 8800, le: 8804, ge: 8805, sum: 8721, part: 8706, isin: 8712, cap: 8745, cup: 8746, sdot: 8901, loz: 9674,
  Alpha: 913, Beta: 914, Gamma: 915, Delta: 916, Theta: 920, Lambda: 923, Pi: 928, Sigma: 931, Phi: 934, Psi: 936, Omega: 937,
  alpha: 945, beta: 946, gamma: 947, delta: 948, epsilon: 949, zeta: 950, eta: 951, theta: 952, iota: 953, kappa: 954, lambda: 955, mu: 956,
  nu: 957, xi: 958, pi: 960, rho: 961, sigma: 963, tau: 964, phi: 966, chi: 967, psi: 968, omega: 969,
};

export function decodeHtmlEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);?/gi, (m, e: string) => {
    if (e[0] === '#') {
      let code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      // Windows-1252's 128–159, as old Windows tools write them (&#150; is an en dash).
      if (code >= 128 && code <= 159) code = CP1252[code - 128] || code;
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    const code = NAMED[e] ?? NAMED[e.toLowerCase()];
    // Without its semicolon, only a known name counts (&copy but not "&co").
    return code ? String.fromCodePoint(code) : m;
  });
}

const CP1252 = [8364, 0, 8218, 402, 8222, 8230, 8224, 8225, 710, 8240, 352, 8249, 338, 0, 381, 0, 0, 8216, 8217, 8220, 8221, 8226, 8211, 8212, 732, 8482, 353, 8250, 339, 0, 382, 376];

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr', 'basefont', 'frame', 'isindex', 'spacer']);
const RAW = new Set(['script', 'style', 'xml', 'textarea', 'title']);
// Opening one of these closes an open <p>.
const CLOSES_P = new Set(['address', 'blockquote', 'div', 'dl', 'fieldset', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'ol', 'p', 'pre', 'table', 'ul', 'li', 'dd', 'dt', 'center']);
// Where an implied end stops looking: an <li> closes the open <li> of its own list only.
const SCOPE: Record<string, Set<string>> = {
  li: new Set(['ul', 'ol', 'table']),
  dt: new Set(['dl', 'table']),
  dd: new Set(['dl', 'table']),
  td: new Set(['tr', 'table']),
  th: new Set(['tr', 'table']),
  tr: new Set(['table']),
  thead: new Set(['table']),
  tbody: new Set(['table']),
  tfoot: new Set(['table']),
  p: new Set(['td', 'th', 'li', 'table', 'div', 'blockquote']),
  option: new Set(['select']),
};
// What an opening tag closes when it's open (within its scope).
const IMPLIES: Record<string, string[]> = {
  li: ['li'],
  dt: ['dt', 'dd'],
  dd: ['dt', 'dd'],
  td: ['td', 'th'],
  th: ['td', 'th'],
  tr: ['td', 'th', 'tr'],
  thead: ['td', 'th', 'tr', 'thead', 'tbody', 'tfoot'],
  tbody: ['td', 'th', 'tr', 'thead', 'tbody', 'tfoot'],
  tfoot: ['td', 'th', 'tr', 'thead', 'tbody', 'tfoot'],
  option: ['option'],
};

// The whole document, as an element named #document. `title` is the <title>'s text.
export function parseHtml(src: string): { doc: XmlElement; title: string } {
  const root: XmlElement = { type: 'el', name: '#document', local: '#document', attrs: {}, children: [] };
  const stack: XmlElement[] = [root];
  let title = '';
  let i = src.charCodeAt(0) === 0xfeff ? 1 : 0;
  const top = () => stack[stack.length - 1];
  const tagName = /[A-Za-z][\w:-]*/y;
  const attr = /\s*([^\s"'>/=]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+)))?/y;

  // Closes the outermost open `names` element below the nearest scope boundary, and all
  // inside it: <tr> closes the open cell and its row; <li> the item of its own list only.
  const closeImplied = (names: string[], scope: Set<string> | undefined) => {
    let cut = -1;
    for (let k = stack.length - 1; k > 0; k--) {
      const n = stack[k].local;
      if (names.includes(n)) cut = k;
      else if (scope?.has(n)) break;
    }
    if (cut > 0) stack.length = cut;
  };

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0 || lt > i) {
      const text = src.slice(i, lt < 0 ? src.length : lt);
      top().children.push({ type: 'text', text: decodeHtmlEntities(text) });
      if (lt < 0) break;
      i = lt;
    }
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      i = end < 0 ? src.length : end + 3;
    } else if (src.startsWith('<![CDATA[', i)) {
      const end = src.indexOf(']]>', i + 9);
      top().children.push({ type: 'text', text: src.slice(i + 9, end < 0 ? src.length : end) });
      i = end < 0 ? src.length : end + 3;
    } else if (src[i + 1] === '!' || src[i + 1] === '?') {
      const end = src.indexOf('>', i);
      i = end < 0 ? src.length : end + 1;
    } else if (src[i + 1] === '/') {
      tagName.lastIndex = i + 2;
      const m = tagName.exec(src);
      const end = src.indexOf('>', i);
      i = end < 0 ? src.length : end + 1;
      if (!m) continue;
      const name = m[0].toLowerCase();
      // Closes the matching open element and anything left open inside it; a stray
      // closing tag is ignored, and </br> is a line break, as browsers read it.
      const at = stack.map((e) => e.local).lastIndexOf(name);
      if (at > 0) stack.length = at;
      else if (name === 'br') top().children.push({ type: 'el', name: 'br', local: 'br', attrs: {}, children: [] });
    } else {
      tagName.lastIndex = i + 1;
      const m = tagName.exec(src);
      if (!m) {
        // A "<" that starts no tag is text.
        top().children.push({ type: 'text', text: '<' });
        i++;
        continue;
      }
      const name = m[0].toLowerCase();
      const el: XmlElement = { type: 'el', name, local: name.slice(name.indexOf(':') + 1), attrs: {}, children: [] };
      let j = tagName.lastIndex;
      for (;;) {
        attr.lastIndex = j;
        const a = attr.exec(src);
        if (!a || !a[1]) break;
        const key = a[1].toLowerCase();
        if (!(key in el.attrs)) el.attrs[key] = decodeHtmlEntities(a[3] ?? a[4] ?? a[5] ?? '');
        j = attr.lastIndex;
      }
      const end = src.indexOf('>', j);
      const selfClosing = end > 0 && src[end - 1] === '/';
      i = end < 0 ? src.length : end + 1;

      if (CLOSES_P.has(el.local)) closeImplied(['p'], SCOPE.p);
      if (IMPLIES[el.local]) closeImplied(IMPLIES[el.local], SCOPE[el.local]);
      if (RAW.has(el.local)) {
        const close = src.toLowerCase().indexOf(`</${el.local}`, i);
        const body = src.slice(i, close < 0 ? src.length : close);
        if (el.local === 'title' && !title) title = decodeHtmlEntities(body).replace(/\s+/g, ' ').trim();
        if (el.local === 'textarea') el.children.push({ type: 'text', text: decodeHtmlEntities(body) });
        if (el.local !== 'script' && el.local !== 'style' && el.local !== 'xml' && el.local !== 'title') top().children.push(el);
        const after = close < 0 ? src.length : src.indexOf('>', close);
        i = after < 0 ? src.length : after + 1;
        continue;
      }
      top().children.push(el);
      if (!VOID.has(el.local) && !selfClosing) stack.push(el);
    }
  }
  return { doc: root, title };
}

// Every element with this name, in document order.
export function allElements(el: XmlElement, local: string, out: XmlElement[] = []): XmlElement[] {
  for (const c of el.children)
    if (c.type === 'el') {
      if (c.local === local) out.push(c);
      allElements(c, local, out);
    }
  return out;
}

// A table's rows (directly, or in its thead/tbody/tfoot), and each row's cells.
export function tableRows(table: XmlElement): XmlElement[][] {
  const rows: XmlElement[][] = [];
  const visit = (e: XmlElement) => {
    for (const c of e.children) {
      if (c.type !== 'el') continue;
      if (c.local === 'tr') rows.push(c.children.filter((x): x is XmlElement => x.type === 'el' && (x.local === 'td' || x.local === 'th')));
      else if (c.local === 'thead' || c.local === 'tbody' || c.local === 'tfoot') visit(c);
    }
  };
  visit(table);
  return rows;
}

// The text of nodes with line breaks where the HTML breaks lines.
export function textLines(nodes: XmlNode[]): string {
  let out = '';
  const BLOCKS = /^(p|div|li|tr|h[1-6]|table|ul|ol|dl|dt|dd|blockquote|pre|center)$/;
  const walk = (ns: XmlNode[]) => {
    for (const n of ns) {
      if (n.type === 'text') out += n.text.replace(/\s+/g, ' ');
      else if (n.local === 'br') out += '\n';
      else {
        const block = BLOCKS.test(n.local);
        if (block) out += '\n';
        walk(n.children);
        if (block) out += '\n';
        else if (n.local === 'td' || n.local === 'th') out += ' ';
      }
    }
  };
  walk(nodes);
  return out
    .split('\n')
    .map((l) => l.replace(/ /g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}
