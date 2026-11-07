// How long a test case takes to run, and so how long a test run will take.
//
//   estimate: 30m        (also: 45, 1h, 1h 30m, 1.5h, 1:30, 2 hours, 90 min)
//
// A bare number is minutes. Kept in minutes.
import type { ProjectIndex } from './model';
import type { TestRun } from './runs';

const UNIT: [RegExp, number][] = [
  [/^(h|hr|hrs|hour|hours|t|tim|timmar)$/i, 60],
  [/^(m|min|mins|minute|minutes|minut|minuter)$/i, 1],
  [/^(d|day|days|dag|dagar)$/i, 8 * 60], // a working day
  [/^$/, 1],
];

// Minutes, or null when it can't be read. Absent (null, '') is undefined.
export function parseDuration(v: unknown): number | null | undefined {
  if (v == null || v === '') return undefined;
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
  const s = String(v).trim().toLowerCase();
  if (!s) return undefined;
  const clock = /^(\d+):([0-5]\d)$/.exec(s);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]);
  const re = /(\d+(?:[.,]\d+)?)\s*([a-zåäö]*)\s*/gy;
  let total = 0;
  let at = 0;
  let parts = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const unit = UNIT.find(([u]) => u.test(m![2]));
    if (!unit) return null;
    // A bare number after an hour means minutes too ("1h 30").
    total += parseFloat(m[1].replace(',', '.')) * unit[1];
    at = re.lastIndex;
    parts++;
  }
  return parts && at === s.length ? Math.round(total) : null;
}

// For people: "45 min", "1 h 30 min", "3 h".
export function formatDuration(minutes: number): string {
  const m = Math.round(minutes);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

// For the front matter: "45m", "1h 30m".
export function durationText(minutes: number): string {
  const m = Math.round(minutes);
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h ? (r ? `${h}h ${r}m` : `${h}h`) : `${r}m`;
}

export interface Estimate {
  minutes: number; // the test cases that have an estimate
  counted: number; // how many have one
  missing: number; // how many don't
}

export function estimateOf(ids: string[], index: ProjectIndex): Estimate {
  const out: Estimate = { minutes: 0, counted: 0, missing: 0 };
  for (const id of ids) {
    const e = index.byId.get(id)?.estimate;
    if (e == null) out.missing++;
    else {
      out.minutes += e;
      out.counted++;
    }
  }
  return out;
}

// A run's estimate: all of it, and what's left (the cases not run yet).
export function runEstimate(run: TestRun, index: ProjectIndex): { total: Estimate; left: Estimate } {
  return {
    total: estimateOf(
      run.cases.map((c) => c.id),
      index,
    ),
    left: estimateOf(
      run.cases.filter((c) => c.result === 'not-run').map((c) => c.id),
      index,
    ),
  };
}

// "about 2 h 30 min (2 test cases have no estimate)"
export function estimateText(e: Estimate): string {
  if (!e.counted) return e.missing ? 'no estimate (no test case has one)' : 'nothing';
  const missing = e.missing ? ` (${e.missing} test case${e.missing === 1 ? ' has' : 's have'} no estimate)` : '';
  return `about ${formatDuration(e.minutes)}${missing}`;
}
