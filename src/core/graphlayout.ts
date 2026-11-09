// Where the graph's nodes go and how its links are drawn, for the screen and the saved
// picture alike. Pure, so it's tested without a browser.
//
// Columns sit side by side. The tallest column is spaced evenly; every other column
// puts each node level with what it's linked to (in the columns already placed), as
// close as the row spacing allows, so links run as flat as they can. Links that skip
// columns pass through the gaps between the nodes in the columns they cross, never
// over a node. Requirements in one column (levels together) are indented under the
// requirement they refine, joined by an elbow on the left.
import type { Column, Graph } from './graph';

export interface LayoutOptions {
  W: number; // column (and node) width
  H: number; // node height
  GAP: number; // between columns
  ROW: number; // vertical pitch: node height plus the room between nodes
  TOP: number; // room for the column headings
  INDENT: number; // per level, for requirements in one column
}

export interface Box {
  x: number;
  y: number;
  w: number;
  col: number;
}

export interface Layout {
  pos: Map<string, Box>;
  colX: number[];
  width: number;
  height: number;
  treeParent: Map<string, string>; // requirements in one column: the one each is shown under
  tops: number[][]; // per column, the nodes' tops in order: where links can't pass
}

const MAX_INDENT_LEVELS = 4;

export function layoutGraph(graph: Graph, cols: Column[], o: LayoutOptions): Layout {
  const colX = cols.map((_, i) => i * (o.W + o.GAP));
  const pos = new Map<string, Box>();
  const treeParent = new Map<string, string>();
  const ys = new Map<string, number>();
  const neighbours = (k: string) => [...(graph.fwd.get(k) ?? []), ...(graph.back.get(k) ?? [])];

  // The tallest column first, evenly spaced; then outwards from it, right then left.
  const anchor = cols.reduce((best, c, i) => (c.nodes.length > cols[best].nodes.length ? i : best), 0);
  const order = [anchor, ...cols.map((_, i) => i).filter((i) => i > anchor), ...cols.map((_, i) => i).filter((i) => i < anchor).reverse()];
  for (const ci of order) {
    const nodes = cols[ci].nodes;
    if (ci === anchor) {
      nodes.forEach((n, i) => ys.set(n.key, o.TOP + i * o.ROW));
      continue;
    }
    const want = nodes.map((n) => {
      const placed = neighbours(n.key)
        .map((k) => ys.get(k))
        .filter((y): y is number => y != null);
      return placed.length ? placed.reduce((a, b) => a + b, 0) / placed.length : NaN;
    });
    pack(want, o.ROW, o.TOP).forEach((y, i) => ys.set(nodes[i].key, y));
  }

  cols.forEach((c, ci) => {
    for (const n of c.nodes) {
      const d = Math.min(MAX_INDENT_LEVELS, c.tree?.depth.get(n.key) ?? 0);
      pos.set(n.key, { x: colX[ci] + d * o.INDENT, y: ys.get(n.key)!, w: o.W - d * o.INDENT, col: ci });
      const parent = c.tree?.parent.get(n.key);
      if (parent) treeParent.set(n.key, parent);
    }
  });
  const bottom = [...ys.values()].reduce((m, y) => Math.max(m, y + o.H), o.TOP);
  const tops = cols.map((c) => c.nodes.map((n) => ys.get(n.key)!).sort((a, b) => a - b));
  return { pos, colX, width: Math.max(o.W, cols.length * (o.W + o.GAP) - o.GAP), height: bottom + 12, treeParent, tops };
}

// Positions for nodes in a fixed order, each as near its wish as the row spacing
// allows: neighbours that would overlap move as a block to their average wish. Nodes
// without a wish follow the one before them (or lead the one after).
export function pack(want: number[], row: number, top: number): number[] {
  const n = want.length;
  if (!n) return [];
  const w = [...want];
  const first = w.findIndex((x) => !Number.isNaN(x));
  if (first < 0) return w.map((_, i) => top + i * row);
  for (let i = first - 1; i >= 0; i--) w[i] = w[i + 1] - row;
  for (let i = first + 1; i < n; i++) if (Number.isNaN(w[i])) w[i] = w[i - 1] + row;
  // Blocks of nodes packed at the row spacing; a block's top is its members' average wish.
  const blocks: { start: number; n: number; sum: number }[] = [];
  for (let i = 0; i < n; i++) {
    let b = { start: i, n: 1, sum: w[i] };
    for (;;) {
      const prev = blocks[blocks.length - 1];
      if (!prev || prev.sum / prev.n + prev.n * row <= b.sum / b.n) break;
      blocks.pop();
      b = { start: prev.start, n: prev.n + b.n, sum: prev.sum + b.sum - b.n * prev.n * row };
    }
    blocks.push(b);
  }
  const out: number[] = [];
  for (const b of blocks) for (let k = 0; k < b.n; k++) out.push(b.sum / b.n + k * row);
  // Not above the headings; push down what that crowds.
  out[0] = Math.max(out[0], top);
  for (let i = 1; i < n; i++) out[i] = Math.max(out[i], out[i - 1] + row);
  return out;
}

const curve = (ax: number, ay: number, bx: number, by: number) => {
  const mx = (ax + bx) / 2;
  return `C ${mx} ${ay}, ${mx} ${by}, ${bx} ${by}`;
};

// A link's path, from the right side of `from` to the left side of `to`.
export function edgePath(lay: Layout, from: string, to: string, o: LayoutOptions): string {
  const p = lay.pos.get(from)!;
  const q = lay.pos.get(to)!;
  const y1 = p.y + o.H / 2;
  const y2 = q.y + o.H / 2;
  if (q.col === p.col) {
    // Requirements in one column: an elbow down the left from the one it's shown under.
    if (lay.treeParent.get(to) === from) {
      const x = p.x + 10;
      return `M ${x} ${p.y + o.H} V ${y2 - 6} Q ${x} ${y2}, ${x + 6} ${y2} H ${q.x}`;
    }
    // Another link in the same column: a loop out to the right.
    const x = lay.colX[p.col] + o.W;
    return `M ${x} ${y1} C ${x + o.GAP / 2} ${y1}, ${x + o.GAP / 2} ${y2}, ${x} ${y2}`;
  }
  if (q.col < p.col) {
    // Backwards (link types in a cycle): from the left side to the right side.
    const xa = lay.colX[p.col];
    const xb = lay.colX[q.col] + o.W;
    return `M ${xa} ${y1} C ${xa - o.GAP / 2} ${y1}, ${xb + o.GAP / 2} ${y2}, ${xb} ${y2}`;
  }
  let x = lay.colX[p.col] + o.W;
  let y = y1;
  let d = `M ${x} ${y}`;
  // Through each column in between, at a height where there's no node.
  for (let c = p.col + 1; c < q.col; c++) {
    const t = (c - p.col) / (q.col - p.col);
    const lane = freeY(lay, c, y1 + (y2 - y1) * t, o);
    d += ` ${curve(x, y, lay.colX[c], lane)} H ${lay.colX[c] + o.W}`;
    x = lay.colX[c] + o.W;
    y = lane;
  }
  return `${d} ${curve(x, y, q.x, y2)}`;
}

// The height nearest `want` at which a line crosses column `col` without touching a node.
export function freeY(lay: Layout, col: number, want: number, o: LayoutOptions, clear = 5): number {
  const tops = lay.tops[col];
  if (!tops?.length) return want;
  // The last node starting above `want` (binary search): the only one it can be inside.
  let lo = 0;
  let hi = tops.length - 1;
  let at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tops[mid] - clear < want) {
      at = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  const inside = (i: number) => i >= 0 && i < tops.length && want > tops[i] - clear && want < tops[i] + o.H + clear;
  if (!inside(at) && !inside(at + 1)) return want;
  const i = inside(at) ? at : at + 1;
  // Just above it (halfway to the one before), or just below (halfway to the one after).
  const above = i > 0 ? (tops[i - 1] + o.H + tops[i]) / 2 : tops[i] - clear;
  const below = i + 1 < tops.length ? (tops[i] + o.H + tops[i + 1]) / 2 : tops[i] + o.H + clear;
  return Math.abs(above - want) <= Math.abs(below - want) ? above : below;
}

// What reaches into a horizontal band of a large graph, without looking at everything:
// each thing is listed in the bands of height `band` its vertical extent covers (a very
// tall one, spanning more than `maxBands`, is checked each time instead). The result
// keeps the things' order.
export function bandIndex<T>(things: T[], extent: (t: T) => [number, number], band = 1000, maxBands = 24): (top: number, bottom: number) => T[] {
  const bands: number[][] = [];
  const tall: number[] = [];
  const spans = things.map(extent);
  spans.forEach(([a, b], i) => {
    const from = Math.max(0, Math.floor(a / band));
    const to = Math.max(from, Math.floor(b / band));
    if (to - from > maxBands) tall.push(i);
    else for (let k = from; k <= to; k++) (bands[k] ??= []).push(i);
  });
  return (top, bottom) => {
    const hit = new Set<number>();
    for (let k = Math.max(0, Math.floor(top / band)); k <= Math.floor(bottom / band); k++) for (const i of bands[k] ?? []) if (spans[i][1] >= top && spans[i][0] <= bottom) hit.add(i);
    for (const i of tall) if (spans[i][1] >= top && spans[i][0] <= bottom) hit.add(i);
    return [...hit].sort((x, y) => x - y).map((i) => things[i]);
  };
}

// A link's path cut to a horizontal band (top…bottom): the parts outside it left out. A
// link running between nodes thousands of pixels apart is then drawn only where it can
// be seen, which keeps scrolling a large graph cheap. Handles what edgePath writes: M, C
// (curves whose height runs one way), H, V and Q (the short elbow, kept whole).
export function clipPath(d: string, top: number, bottom: number): string {
  const tokens = d.match(/[MCHVQ]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? [];
  let i = 0;
  const num = () => Number(tokens[i++]);
  let x = 0;
  let y = 0;
  let out = '';
  let pen = false; // whether the output's current point is (x, y)
  const inside = (v: number) => v >= top && v <= bottom;
  const moveTo = (px: number, py: number) => {
    if (!pen) out += `${out ? ' ' : ''}M ${px} ${py}`;
    pen = true;
  };
  // The point and the split of a cubic at t (de Casteljau).
  const lerp = (a: number[], b: number[], t: number) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const split = (p: number[][], t: number): [number[][], number[][]] => {
    const ab = lerp(p[0], p[1], t);
    const bc = lerp(p[1], p[2], t);
    const cd = lerp(p[2], p[3], t);
    const abc = lerp(ab, bc, t);
    const bcd = lerp(bc, cd, t);
    const m = lerp(abc, bcd, t);
    return [
      [p[0], ab, abc, m],
      [m, bcd, cd, p[3]],
    ];
  };
  const yAt = (p: number[][], t: number) => {
    const u = 1 - t;
    return u * u * u * p[0][1] + 3 * u * u * t * p[1][1] + 3 * u * t * t * p[2][1] + t * t * t * p[3][1];
  };
  // Where the curve's height reaches `v` (it runs one way between its ends).
  const tAt = (p: number[][], v: number) => {
    let lo = 0;
    let hi = 1;
    const rising = p[3][1] >= p[0][1];
    for (let k = 0; k < 40; k++) {
      const mid = (lo + hi) / 2;
      if (yAt(p, mid) < v === rising) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (cmd === 'M') {
      x = num();
      y = num();
      pen = false;
      if (inside(y)) moveTo(x, y);
    } else if (cmd === 'H') {
      const nx = num();
      if (inside(y)) {
        moveTo(x, y);
        out += ` H ${nx}`;
      }
      x = nx;
    } else if (cmd === 'V') {
      const ny = num();
      const a = Math.max(Math.min(y, ny), top);
      const b = Math.min(Math.max(y, ny), bottom);
      if (a <= b) {
        const [from, to] = ny >= y ? [a, b] : [b, a];
        if (from !== y) pen = false;
        moveTo(x, from);
        out += ` V ${to}`;
        pen = to === ny;
      } else pen = false;
      y = ny;
    } else if (cmd === 'Q') {
      const c = [num(), num(), num(), num()];
      if (inside(y) || inside(c[3])) {
        moveTo(x, y);
        out += ` Q ${c[0]} ${c[1]}, ${c[2]} ${c[3]}`;
      } else pen = false;
      [x, y] = [c[2], c[3]];
    } else if (cmd === 'C') {
      const p = [[x, y], [num(), num()], [num(), num()], [num(), num()]];
      const [y0, y3] = [p[0][1], p[3][1]];
      if (inside(y0) && inside(y3)) {
        moveTo(x, y);
        out += ` C ${p[1][0]} ${p[1][1]}, ${p[2][0]} ${p[2][1]}, ${p[3][0]} ${p[3][1]}`;
      } else if (Math.max(y0, y3) >= top && Math.min(y0, y3) <= bottom) {
        // Partly in the band: the piece of the curve inside it.
        const lo = Math.max(top, Math.min(y0, y3));
        const hi = Math.min(bottom, Math.max(y0, y3));
        let t0 = y3 >= y0 ? tAt(p, lo) : tAt(p, hi);
        let t1 = y3 >= y0 ? tAt(p, hi) : tAt(p, lo);
        if (inside(y0)) t0 = 0;
        if (inside(y3)) t1 = 1;
        let piece = p;
        if (t1 < 1) piece = split(piece, t1)[0];
        if (t0 > 0) piece = split(piece, t0 / (t1 || 1))[1];
        if (t0 > 0) pen = false;
        moveTo(piece[0][0], piece[0][1]);
        out += ` C ${piece[1][0]} ${piece[1][1]}, ${piece[2][0]} ${piece[2][1]}, ${piece[3][0]} ${piece[3][1]}`;
        pen = t1 === 1;
      } else pen = false;
      [x, y] = p[3] as [number, number];
    }
  }
  return out;
}
