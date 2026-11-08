// One change to many items: set or clear single fields, add or remove values in list
// fields. Gives each file's field changes, only where something actually changes.
import { listValue } from './fields';
import { fingerprint, type Item, type ProjectIndex } from './model';

export interface BulkEdit {
  set: Record<string, unknown>; // field → new value; null clears it
  add: Record<string, string[]>; // list field → values to add
  remove: Record<string, string[]>; // list field → values to take away
}

export const emptyEdit = (): BulkEdit => ({ set: {}, add: {}, remove: {} });

function current(item: Item, key: string): string[] {
  if (key === 'components' || key === 'variants' || key === 'jira' || key === 'verifies' || key === 'refines' || key === 'evidence') return item[key];
  return listValue(item.data[key]);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// path → the fields to write (undefined removes one). Items nothing changes in are left out.
export function bulkChanges(items: Item[], edit: BulkEdit, index: ProjectIndex): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const it of items) {
    const changes: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(edit.set)) {
      if (key === 'verification' && it.kind !== 'requirement') continue;
      // Verified by test is the default: no need to write it.
      const now = value === null || value === '' || (key === 'verification' && value === 'test') ? undefined : value;
      if (!same(it.data[key] === '' ? undefined : it.data[key], now)) changes[key] = now;
    }
    for (const key of new Set([...Object.keys(edit.add), ...Object.keys(edit.remove)])) {
      if ((key === 'verifies' && it.kind !== 'testcase') || ((key === 'refines' || key === 'evidence') && it.kind !== 'requirement')) continue;
      const before = current(it, key);
      const drop = new Set(edit.remove[key] ?? []);
      // (A requirement can't refine itself.)
      const adding = (edit.add[key] ?? []).filter((v) => !before.includes(v) && !drop.has(v) && !(key === 'refines' && v === it.id));
      const after = [...before.filter((v) => !drop.has(v)), ...adding];
      if (same(before, after)) continue;
      changes[key] = after.length ? after : undefined;
      // A link added here counts as reviewed now; one removed loses its review. The
      // reviews of the other links stay.
      if (key === 'verifies' || key === 'refines') {
        const base = 'reviewed' in changes ? ((changes.reviewed as Record<string, string> | undefined) ?? {}) : it.reviewed;
        const reviewed: Record<string, string> = {};
        for (const [k, v] of Object.entries(base)) if (!before.includes(k) || after.includes(k)) reviewed[k] = v;
        for (const v of after)
          if (!reviewed[v] && !before.includes(v)) {
            const req = index.byId.get(v);
            if (req) reviewed[v] = fingerprint(req);
          }
        if (!same(reviewed, it.reviewed)) changes.reviewed = Object.keys(reviewed).length ? reviewed : undefined;
      }
    }
    if (Object.keys(changes).length) out.set(it.path, changes);
  }
  return out;
}
