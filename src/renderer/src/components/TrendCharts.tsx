// Coverage over time: the share of requirements verified by a test case at each test
// run (and now), and each run's results. Two charts on the same run positions, and the
// same numbers as a table.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { pct, type TrendPoint } from '../../../core/trend';
import { RESULT_LABEL } from './bits';

const PLOT_H = 170;
const AXIS_H = 34; // room for the run labels under the plot
const PAD_L = 40; // y-axis labels
const PAD_R = 44; // the end label
const PAD_T = 14;

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

// Clean axis steps: 1, 2 or 5 × 10ⁿ, at most five of them.
function ticks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const out: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(Math.round(v * 1e6) / 1e6);
  if (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
  return out;
}

const shortLabel = (p: TrendPoint) => (p.run ? p.version || p.label : 'Now');

interface Frame {
  width: number;
  x: (i: number) => number;
  slot: number;
  labelEvery: number;
}

function frame(width: number, n: number): Frame {
  const inner = Math.max(width - PAD_L - PAD_R, 40);
  const slot = inner / Math.max(n, 1);
  return { width, slot, x: (i) => PAD_L + slot * (i + 0.5), labelEvery: Math.max(1, Math.ceil(70 / slot)) };
}

function XLabels({ points, f }: { points: TrendPoint[]; f: Frame }) {
  return (
    <>
      {points.map((p, i) =>
        i % f.labelEvery === 0 || i === points.length - 1 ? (
          <text key={i} className="chart-axis" x={f.x(i)} y={PAD_T + PLOT_H + 16} textAnchor="middle">
            {shortLabel(p).length > 12 ? shortLabel(p).slice(0, 11) + '…' : shortLabel(p)}
          </text>
        ) : null,
      )}
    </>
  );
}

// Beside the hovered run, never over it: on the right in the left half, else on the left.
function Tooltip({ f, i, children }: { f: Frame; i: number; children: ReactNode }) {
  const gap = Math.min(f.slot / 2, 24) + 8;
  const side = f.x(i) < f.width / 2 ? { left: f.x(i) + gap } : { right: f.width - f.x(i) + gap };
  return (
    <div className="chart-tip" style={side} role="status">
      {children}
    </div>
  );
}

function when(p: TrendPoint) {
  return p.run ? `${p.label} · ${p.date || 'no date'}` : 'Now · this branch’s files';
}

export function CoverageLine({ points }: { points: TrendPoint[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const f = frame(width, points.length);
  const y = (v: number) => PAD_T + PLOT_H - (v / 100) * PLOT_H;
  // A run whose requirements couldn't be read leaves a gap in the line.
  const segments: { i: number; v: number }[][] = [];
  let cur: { i: number; v: number }[] = [];
  points.forEach((p, i) => {
    if (p.coverage) cur.push({ i, v: pct(p.coverage) });
    else if (cur.length) {
      segments.push(cur);
      cur = [];
    }
  });
  if (cur.length) segments.push(cur);
  const known = points.map((p, i) => ({ p, i })).filter((d) => d.p.coverage);
  const lastKnown = known[known.length - 1];
  const hp = hover != null ? points[hover] : null;

  return (
    <figure className="chart" ref={ref} onPointerLeave={() => setHover(null)}>
      <figcaption>
        <span className="chart-title">Requirements covered</span>
        <span className="muted small">Share of requirements needing verification that a test case, evidence, or the requirements refining them cover</span>
      </figcaption>
      {width > 0 && (
        <svg width={width} height={PAD_T + PLOT_H + AXIS_H} role="img" aria-label="Requirements covered, at each test run and now">
          {[0, 25, 50, 75, 100].map((v) => (
            <g key={v}>
              <line className="chart-grid" x1={PAD_L} x2={width - PAD_R} y1={y(v)} y2={y(v)} />
              <text className="chart-axis" x={PAD_L - 8} y={y(v) + 4} textAnchor="end">
                {v}%
              </text>
            </g>
          ))}
          <XLabels points={points} f={f} />
          {hover != null && <line className="chart-crosshair" x1={f.x(hover)} x2={f.x(hover)} y1={PAD_T} y2={PAD_T + PLOT_H} />}
          {segments.map((s, k) => (
            <polyline key={k} className="chart-line" points={s.map((d) => `${f.x(d.i)},${y(d.v)}`).join(' ')} />
          ))}
          {known.map(({ p, i }) => (
            <circle key={i} className={`chart-dot${i === hover ? ' on' : ''}`} cx={f.x(i)} cy={y(pct(p.coverage!))} r={4} />
          ))}
          {lastKnown && (
            <text className="chart-end" x={f.x(lastKnown.i) + 9} y={y(pct(lastKnown.p.coverage!)) + 4}>
              {pct(lastKnown.p.coverage!)}%
            </text>
          )}
          {points.map((p, i) => (
            <rect
              key={i}
              className="chart-hit"
              x={f.x(i) - f.slot / 2}
              y={PAD_T}
              width={f.slot}
              height={PLOT_H}
              tabIndex={0}
              aria-label={`${when(p)}: ${p.coverage ? `${pct(p.coverage)}%, ${p.coverage.tested} of ${p.coverage.requirements} requirements` : 'not known'}`}
              onPointerEnter={() => setHover(i)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
            />
          ))}
        </svg>
      )}
      {hp && hover != null && (
        <Tooltip f={f} i={hover}>
          <strong className="chart-tip-value">{hp.coverage ? `${pct(hp.coverage)}%` : 'Not known'}</strong>
          <span>{when(hp)}</span>
          {hp.coverage ? (
            <span className="muted">
              {hp.coverage.tested} of {hp.coverage.requirements} requirements · {hp.coverage.suspect} link{hp.coverage.suspect === 1 ? '' : 's'} to review
            </span>
          ) : (
            <span className="muted">The run doesn’t say which requirements it started from, or that commit isn’t here.</span>
          )}
        </Tooltip>
      )}
    </figure>
  );
}

const STACK = ['passed', 'failed', 'blocked', 'not-run'] as const; // bottom to top
const countOf = (p: TrendPoint, r: (typeof STACK)[number]) => (!p.results ? 0 : r === 'not-run' ? p.results.notRun : p.results[r]);

// A column segment: square at the bottom, 4px rounded top when it ends the column.
function segPath(x: number, w: number, top: number, bottom: number, rounded: boolean) {
  const r = rounded ? Math.min(4, (bottom - top) / 2, w / 2) : 0;
  return `M${x},${bottom}V${top + r}${r ? `Q${x},${top} ${x + r},${top}` : ''}H${x + w - r}${r ? `Q${x + w},${top} ${x + w},${top + r}` : ''}V${bottom}Z`;
}

export function ResultColumns({ points }: { points: TrendPoint[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const f = frame(width, points.length);
  const max = Math.max(1, ...points.map((p) => p.results?.total ?? 0));
  const t = ticks(max);
  const top = t[t.length - 1];
  const y = (v: number) => PAD_T + PLOT_H - (v / top) * PLOT_H;
  const w = Math.min(24, Math.max(4, f.slot * 0.5));
  const hp = hover != null ? points[hover] : null;

  return (
    <figure className="chart" ref={ref} onPointerLeave={() => setHover(null)}>
      <figcaption>
        <span className="chart-title">Results per run</span>
        <span className="chart-legend">
          {STACK.map((r) => (
            <span key={r}>
              <span className={`chart-swatch ${r}`} />
              {RESULT_LABEL[r]}
            </span>
          ))}
        </span>
      </figcaption>
      {width > 0 && (
        <svg width={width} height={PAD_T + PLOT_H + AXIS_H} role="img" aria-label="Test results per run">
          {t.map((v) => (
            <g key={v}>
              <line className="chart-grid" x1={PAD_L} x2={width - PAD_R} y1={y(v)} y2={y(v)} />
              <text className="chart-axis" x={PAD_L - 8} y={y(v) + 4} textAnchor="end">
                {v.toLocaleString()}
              </text>
            </g>
          ))}
          <XLabels points={points} f={f} />
          {points.map((p, i) => {
            if (!p.results) return null;
            const parts = STACK.map((r) => ({ r, n: countOf(p, r) })).filter((s) => s.n > 0);
            let base = 0;
            return (
              <g key={i} className={hover === i ? 'chart-col on' : 'chart-col'}>
                {parts.map((s, k) => {
                  const bottom = y(base) - (k > 0 ? 2 : 0); // 2px surface gap between segments
                  base += s.n;
                  const topY = y(base);
                  return bottom - topY > 0.5 ? <path key={s.r} className={`chart-seg ${s.r}`} d={segPath(f.x(i) - w / 2, w, topY, bottom, k === parts.length - 1)} /> : null;
                })}
              </g>
            );
          })}
          {points.map((p, i) => (
            <rect
              key={i}
              className="chart-hit"
              x={f.x(i) - f.slot / 2}
              y={PAD_T}
              width={f.slot}
              height={PLOT_H}
              tabIndex={p.results ? 0 : -1}
              aria-label={
                p.results ? `${when(p)}: ${p.results.passed} passed, ${p.results.failed} failed, ${p.results.blocked} blocked, ${p.results.notRun} not run` : 'Now: no run'
              }
              onPointerEnter={() => setHover(p.results ? i : null)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
            />
          ))}
        </svg>
      )}
      {hp?.results && hover != null && (
        <Tooltip f={f} i={hover}>
          <span>{when(hp)}</span>
          {STACK.map((r) => (
            <span key={r} className="chart-tip-row">
              <span className={`chart-key ${r}`} />
              <strong>{countOf(hp, r)}</strong> {RESULT_LABEL[r].toLowerCase()}
            </span>
          ))}
          <span className="muted">
            {hp.results.done} of {hp.results.total} run{hp.passing != null ? ` · ${hp.passing} requirement${hp.passing === 1 ? '' : 's'} passing` : ''}
          </span>
        </Tooltip>
      )}
    </figure>
  );
}

export function TrendTable({ points }: { points: TrendPoint[] }) {
  const n = (v: number | null | undefined) => (v == null ? <span className="muted">—</span> : v.toLocaleString());
  return (
    <div className="table-scroll">
      <table className="matrix trend-table">
        <thead>
          <tr>
            <th>Run</th>
            <th>Date</th>
            <th>Version</th>
            <th className="num">Requirements</th>
            <th className="num">With tests</th>
            <th className="num">Covered</th>
            <th className="num">To review</th>
            <th className="num">Passed</th>
            <th className="num">Failed</th>
            <th className="num">Blocked</th>
            <th className="num">Not run</th>
            <th className="num" title="Requirements with a passing test in the run and no failed or blocked one">
              Req. passing
            </th>
          </tr>
        </thead>
        <tbody>
          {[...points].reverse().map((p, i) => (
            <tr key={i}>
              <td>{p.run ? p.label : <strong>Now</strong>}</td>
              <td className="small">{p.date}</td>
              <td className="small mono">{p.version ?? ''}</td>
              <td className="num">{n(p.coverage?.requirements)}</td>
              <td className="num">{n(p.coverage?.tested)}</td>
              <td className="num">{p.coverage ? `${pct(p.coverage)}%` : <span className="muted">—</span>}</td>
              <td className="num">{n(p.coverage?.suspect)}</td>
              <td className="num">{n(p.results?.passed)}</td>
              <td className="num">{n(p.results?.failed)}</td>
              <td className="num">{n(p.results?.blocked)}</td>
              <td className="num">{n(p.results?.notRun)}</td>
              <td className="num">{n(p.passing)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
