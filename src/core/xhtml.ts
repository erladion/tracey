// XHTML (as ReqIF carries rich text) to Markdown: paragraphs, headings, bold, italic,
// strikethrough, code, links, lists, tables, quotes and pictures. Anything else keeps its
// text. Embedded objects become images when there's a picture of them.
import { elements, textOf, type XmlElement, type XmlNode } from './xml';

export interface XhtmlContext {
  // An embedded file (`data` as written in the XHTML, its MIME type): the Markdown
  // src to show it with, or null if it can't be shown.
  image(data: string, type: string): string | null;
  // Embedded objects that weren't shown, for the import report.
  skipped?: (what: string) => void;
}

const BLOCK = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'table', 'pre', 'blockquote', 'hr', 'li', 'dl']);

const escapeText = (s: string) => s.replace(/([\\`*_[\]])/g, '\\$1');
// A paragraph that would start like a heading, list or quote is escaped.
const escapeStart = (s: string) => s.replace(/^(\s*)([#>+-]|\d+[.)])(?=\s|$)/, (_m, sp: string, c: string) => `${sp}${c.replace(/^([#>+-]|\d+)/, '\\$1')}`);

function style(el: XmlElement): { bold: boolean; italic: boolean; strike: boolean } {
  const s = (el.attrs.style ?? '').toLowerCase();
  return {
    bold: /font-weight\s*:\s*(bold|[6-9]00)/.test(s),
    italic: /font-style\s*:\s*italic/.test(s),
    strike: /text-decoration[^;]*line-through/.test(s),
  };
}

const wrap = (s: string, mark: string) => {
  // Marks go around the words, not the spaces next to them.
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s)!;
  return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : s;
};

function objectImage(el: XmlElement, ctx: XhtmlContext): string {
  // An OLE object usually carries a picture of itself as a nested object.
  const candidates = [el, ...elements(el, 'object')];
  for (const c of candidates) {
    const type = (c.attrs.type ?? '').toLowerCase();
    const data = c.attrs.data ?? '';
    if (data && (type.startsWith('image/') || /\.(png|jpe?g|gif|bmp|webp|svg)$/i.test(data))) {
      const src = ctx.image(data, type || 'image/' + data.split('.').pop()!.toLowerCase());
      if (src) return `![${escapeText(c.attrs.name ?? '')}](${src.replace(/[ ()]/g, (ch) => encodeURIComponent(ch))})`;
    }
  }
  const what = el.attrs.name || el.attrs.data || 'an embedded object';
  ctx.skipped?.(what);
  return `*(embedded object not imported: ${escapeText(what.split('/').pop()!)})*`;
}

function inline(nodes: XmlNode[], ctx: XhtmlContext): string {
  let out = '';
  for (const n of nodes) {
    if (n.type === 'text') {
      out += escapeText(n.text.replace(/\s+/g, ' '));
      continue;
    }
    const tag = n.local.toLowerCase();
    const inner = () => inline(n.children, ctx);
    switch (tag) {
      case 'br':
        out += '\\\n';
        break;
      case 'b':
      case 'strong':
        out += wrap(inner(), '**');
        break;
      case 'i':
      case 'em':
      case 'cite':
        out += wrap(inner(), '*');
        break;
      case 's':
      case 'strike':
      case 'del':
        out += wrap(inner(), '~~');
        break;
      case 'code':
      case 'tt':
      case 'kbd': {
        const t = textOf(n).replace(/\s+/g, ' ');
        const fence = t.includes('`') ? '``' : '`';
        out += t.trim() ? `${fence}${t}${fence}` : t;
        break;
      }
      case 'a': {
        const href = n.attrs.href ?? '';
        const text = inner();
        out += /^(https?:|mailto:)/i.test(href) ? `[${text || href}](${href.replace(/[ ()]/g, (ch) => encodeURIComponent(ch))})` : text;
        break;
      }
      case 'object':
        out += objectImage(n, ctx);
        break;
      case 'img': {
        const src = n.attrs.src ? ctx.image(n.attrs.src, '') : null;
        out += src ? `![${escapeText(n.attrs.alt ?? '')}](${src})` : '';
        break;
      }
      case 'span':
      case 'font': {
        const st = style(n);
        let t = inner();
        if (st.strike) t = wrap(t, '~~');
        if (st.italic) t = wrap(t, '*');
        if (st.bold) t = wrap(t, '**');
        out += t;
        break;
      }
      default:
        // u, sub, sup, small, abbr, … and any block element met inline: its text.
        out += BLOCK.has(tag) ? ` ${inner()} ` : inner();
    }
  }
  return out;
}

const tidy = (s: string) =>
  s
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\\\n ?/g, '\\\n')
    .trim()
    .replace(/(\\\n)+$/, '');

function table(el: XmlElement, ctx: XhtmlContext): string {
  const rows: { cells: string[]; header: boolean }[] = [];
  const collect = (e: XmlElement) => {
    for (const c of elements(e)) {
      const tag = c.local.toLowerCase();
      if (tag === 'tr') {
        const cells = elements(c).filter((x) => /^t[dh]$/i.test(x.local));
        rows.push({
          // A table cell holds one line: breaks and paragraphs become spaces.
          cells: cells.map((x) => tidy(inline(x.children, ctx)).replace(/\\\n/g, ' ').replace(/\|/g, '\\|')),
          header: cells.length > 0 && cells.every((x) => x.local.toLowerCase() === 'th'),
        });
      } else if (['thead', 'tbody', 'tfoot'].includes(tag)) collect(c);
    }
  };
  collect(el);
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.cells.length), 1);
  const pad = (cells: string[]) => [...cells, ...Array(width - cells.length).fill('')];
  // Markdown tables need a header row: the first row is it, header cells or not.
  const [head, ...body] = rows;
  const line = (cells: string[]) => `| ${pad(cells).join(' | ')} |`;
  return [line(head.cells), `| ${Array(width).fill('---').join(' | ')} |`, ...body.map((r) => line(r.cells))].join('\n');
}

function list(el: XmlElement, ctx: XhtmlContext, ordered: boolean): string {
  const items = elements(el, 'li');
  return items
    .map((li, i) => {
      const marker = ordered ? `${i + 1}. ` : '- ';
      // A nested list follows its item's text directly, keeping the list tight.
      const parts = blocks(li.children, ctx);
      const content = parts.map((p, j) => (j === 0 ? p : (/^(- |\d+\. )/.test(p) ? '\n' : '\n\n') + p)).join('') || ' ';
      const indent = ' '.repeat(marker.length);
      return marker + content.split('\n').map((l, j) => (j === 0 || !l ? l : indent + l)).join('\n');
    })
    .join('\n');
}

function blocks(nodes: XmlNode[], ctx: XhtmlContext): string[] {
  const out: string[] = [];
  let run: XmlNode[] = [];
  const flush = () => {
    const t = tidy(inline(run, ctx));
    if (t) out.push(escapeStart(t));
    run = [];
  };
  for (const n of nodes) {
    const tag = n.type === 'el' ? n.local.toLowerCase() : '';
    if (n.type === 'text' || !BLOCK.has(tag)) {
      run.push(n);
      continue;
    }
    flush();
    const el = n as XmlElement;
    if (tag === 'p') {
      const t = tidy(inline(el.children, ctx));
      if (t) out.push(escapeStart(t));
    } else if (tag === 'div' || tag === 'li' || tag === 'dl') out.push(...blocks(el.children, ctx));
    else if (/^h[1-6]$/.test(tag)) {
      const t = tidy(inline(el.children, ctx)).replace(/\\\n/g, ' ');
      if (t) out.push(`${'#'.repeat(Number(tag[1]))} ${t}`);
    } else if (tag === 'ul' || tag === 'ol') {
      const t = list(el, ctx, tag === 'ol');
      if (t.trim()) out.push(t);
    } else if (tag === 'table') {
      const t = table(el, ctx);
      if (t) out.push(t);
    } else if (tag === 'pre') {
      const t = textOf(el).replace(/\n+$/, '');
      const fence = t.includes('```') ? '~~~~' : '```';
      out.push(`${fence}\n${t}\n${fence}`);
    } else if (tag === 'blockquote') {
      const t = blocks(el.children, ctx).join('\n\n');
      if (t) out.push(t.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n'));
    } else if (tag === 'hr') out.push('---');
  }
  flush();
  return out;
}

export function xhtmlToMarkdown(nodes: XmlNode[], ctx: XhtmlContext): string {
  return blocks(nodes, ctx).join('\n\n');
}
