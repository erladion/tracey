// The traceability graph as a standalone SVG picture, for documents: what's shown on
// screen, laid out the same, in the light theme's colours. The PNG is drawn from it.
import type { GNode } from './graph';

export interface PictureNode {
  x: number;
  y: number;
  node: GNode;
  dim?: boolean;
  selected?: boolean;
  onPath?: boolean;
}

export interface PictureEdge {
  d: string; // the path, in the same coordinates as the nodes
  hot?: boolean;
  suspect?: boolean;
  dim?: boolean;
}

export interface GraphPicture {
  width: number;
  height: number;
  nodeW: number;
  nodeH: number;
  heads: { x: number; label: string; count: number }[];
  nodes: PictureNode[];
  edges: PictureEdge[];
}

// The light theme (styles.css :root).
const C = {
  bg: '#ffffff',
  surface: '#ffffff',
  surface2: '#f0f0ec',
  border: '#d6d6d0',
  fg: '#1a1a1a',
  muted: '#5c5c58',
  accent: '#2453c7',
  accentSoft: '#e6eefb',
  accentFg: '#1e3f8f',
  accentLine: '#a9c0ee',
  onAccent: '#ffffff',
  warn: '#8a3b00',
  warnSoft: '#fdebd8',
  warnLine: '#b85a1a',
  purple: '#5b3fb8',
};
const UI = "Inter, 'Segoe UI', system-ui, sans-serif";
const MONO = "'JetBrains Mono', 'DejaVu Sans Mono', Consolas, monospace";
const MARGIN = 16;

export const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Text cut to roughly fit a width, with an ellipsis: SVG doesn't do that by itself.
export function fit(text: string, width: number, charW: number): string {
  const max = Math.max(1, Math.floor(width / charW));
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function nodeSvg({ x, y, node: n, dim, selected, onPath }: PictureNode, W: number, H: number): string {
  const warn = !!n.gap && !!n.warn;
  const gap = !!n.gap && !n.warn;
  let fill = n.type === 'issue' ? C.surface2 : n.type === 'req' ? C.accentSoft : C.surface;
  let stroke = n.type === 'req' ? C.accentLine : C.border;
  let strokeW = 1;
  let dash = '';
  let title = n.type === 'req' ? C.accentFg : n.type === 'commit' ? C.purple : C.fg;
  let sub = n.type === 'req' ? C.accentFg : C.muted;
  if (gap) [stroke, strokeW, dash] = [C.warnLine, 2, '6 4'];
  if (warn) [fill, stroke, strokeW, title, sub] = [C.warnSoft, C.warnLine, 2, C.warn, C.warn];
  if (onPath) [stroke, strokeW, dash] = [warn ? C.warnLine : C.accent, 2, ''];
  if (selected) [fill, stroke, strokeW, dash, title, sub] = [C.accent, C.accent, 2, '', C.onAccent, C.onAccent];

  const inset = strokeW / 2;
  const parts: string[] = [];
  if (selected) parts.push(`<rect x="${x - 4.5}" y="${y - 4.5}" width="${W + 9}" height="${H + 9}" rx="13" fill="none" stroke="${C.accent}" stroke-width="3"/>`);
  parts.push(
    `<rect x="${x + inset}" y="${y + inset}" width="${W - strokeW}" height="${H - strokeW}" rx="10" fill="${fill}" stroke="${stroke}" stroke-width="${strokeW}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`,
  );
  if (n.type === 'commit' && !selected) parts.push(`<path d="M ${x + 1.5} ${y + 8} V ${y + H - 8}" stroke="${C.purple}" stroke-width="3" stroke-linecap="round"/>`);
  const room = W - 24;
  const titleFont = n.type === 'component' ? `font-family="${UI}" font-size="13" font-weight="600"` : `font-family="${MONO}" font-size="12" font-weight="500"`;
  const titleText = fit(n.label, room, n.type === 'component' ? 7.6 : 7.3);
  parts.push(
    `<text x="${x + 12}" y="${y + 24}" ${titleFont} fill="${title}"${n.status === 'obsolete' ? ' text-decoration="line-through"' : ''}>${xml(titleText)}</text>`,
  );
  if (n.sub) parts.push(`<text x="${x + 12}" y="${y + 41}" font-family="${UI}" font-size="12" fill="${sub}">${xml(fit(n.sub, room, 6.6))}</text>`);
  if (n.tag) {
    const w = Math.ceil(n.tag.length * 6.4) + 16;
    const tx = x + W - 8 - w;
    parts.push(
      `<rect x="${tx}" y="${y - 10}" width="${w}" height="18" rx="9" fill="${warn ? C.warnLine : C.warnSoft}" stroke="${C.warnLine}"/>`,
      `<text x="${tx + w / 2}" y="${y + 3}" text-anchor="middle" font-family="${UI}" font-size="11" font-weight="600" fill="${warn ? C.onAccent : C.warn}">${xml(n.tag)}</text>`,
    );
  }
  return `<g${dim ? ' opacity="0.45"' : ''}>${n.item || n.issue || n.commit ? `<title>${xml(`${n.label}: ${n.sub}`)}</title>` : ''}${parts.join('')}</g>`;
}

export function graphSvg(p: GraphPicture): string {
  const w = Math.ceil(p.width + 2 * MARGIN);
  const h = Math.ceil(p.height + 2 * MARGIN);
  const edges = p.edges.map((e) => {
    const stroke = e.suspect ? C.warnLine : e.hot ? C.accent : C.border;
    return `<path d="${e.d}" fill="none" stroke="${stroke}" stroke-width="${e.hot ? 2.5 : 1.5}"${e.suspect ? ' stroke-dasharray="5 4"' : ''}${e.dim ? ' opacity="0.25"' : ''}/>`;
  });
  const heads = p.heads.map(
    (c) => `<text x="${c.x}" y="14" font-family="${UI}" font-size="13"><tspan font-weight="600" fill="${C.fg}">${xml(c.label)}</tspan><tspan fill="${C.muted}"> ${c.count}</tspan></text>`,
  );
  // Selected last, so its ring is drawn over its neighbours.
  const order = [...p.nodes].sort((a, b) => Number(!!a.selected) - Number(!!b.selected));
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
    `<rect width="${w}" height="${h}" fill="${C.bg}"/>`,
    `<g transform="translate(${MARGIN} ${MARGIN})">`,
    ...edges,
    ...heads,
    ...order.map((n) => nodeSvg(n, p.nodeW, p.nodeH)),
    '</g>',
    '</svg>',
  ].join('\n');
}
