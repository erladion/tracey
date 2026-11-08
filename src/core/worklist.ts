// The work list: tests collected while looking around the project (a test case, a
// requirement's tests, what a search found), to start a test run with or add to one. Each
// entry says why it's there, which becomes the case's reason in the run.
import { isRunnable, isVerifiable } from './config';
import type { Item, ProjectIndex } from './model';

export interface WorkEntry {
  id: string;
  reason: string; // "Verifies REQ-07", "Picked by hand"
}

// The tests an item stands for: a test itself; the tests verifying a verified item (a
// requirement, an architecture element…); for a requirement, also those of the
// requirements refining it, all the way down. Obsolete tests are left out. `picked` is
// the reason given to tests taken as they are ("Found searching “retry”").
export function testsFor(index: ProjectIndex, items: Item[], picked = 'Picked by hand'): WorkEntry[] {
  const out = new Map<string, WorkEntry>();
  const add = (t: Item, reason: string) => {
    if (t.status !== 'obsolete' && !out.has(t.id)) out.set(t.id, { id: t.id, reason });
  };
  for (const it of items) {
    if (isRunnable(index.config, it.kind)) {
      add(it, picked);
      continue;
    }
    if (!isVerifiable(index.config, it.kind)) continue;
    for (const t of index.verifiedBy.get(it.id) ?? []) add(t, `Verifies ${it.id}`);
    if (it.kind !== 'requirement') continue;
    // Down the refinements; each requirement once, so a loop ends.
    const seen = new Set([it.id]);
    const queue = [...(index.refinedBy.get(it.id) ?? [])];
    while (queue.length) {
      const r = queue.shift()!;
      if (seen.has(r.id) || r.status === 'obsolete') continue;
      seen.add(r.id);
      for (const t of index.verifiedBy.get(r.id) ?? []) add(t, `Verifies ${r.id}, which refines ${it.id}`);
      queue.push(...(index.refinedBy.get(r.id) ?? []));
    }
  }
  return [...out.values()];
}

// Entries added to a list: those not in it yet, at the end.
export function addEntries(list: WorkEntry[], more: WorkEntry[]): WorkEntry[] {
  const have = new Set(list.map((e) => e.id));
  const added: WorkEntry[] = [];
  for (const e of more)
    if (!have.has(e.id)) {
      have.add(e.id);
      added.push(e);
    }
  return [...list, ...added];
}
