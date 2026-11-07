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
  if (key === 'components' || key === 'variants' || key === 'jira' || key === 'verifies') return item[key];
  return listValue(item.data[key]);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// path → the fields to write (undefined removes one). Items nothing changes in are left out.
export function bulkChanges(items: Item[], edit: BulkEdit, index: ProjectIndex): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const it of items) {
    const changes: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(edit.set)) {
      const now = value === null || value === '' ? undefined : value;
      if (!same(it.data[key] === '' ? undefined : it.data[key], now)) changes[key] = now;
    }
    for (const key of new Set([...Object.keys(edit.add), ...Object.keys(edit.remove)])) {
      if (key === 'verifies' && it.kind !== 'testcase') continue;
      const before = current(it, key);
      const drop = new Set(edit.remove[key] ?? []);
      const after = [...before.filter((v) => !drop.has(v)), ...(edit.add[key] ?? []).filter((v) => !before.includes(v) && !drop.has(v))];
      if (same(before, after)) continue;
      changes[key] = after.length ? after : undefined;
      // A link added here counts as reviewed now; one removed loses its review.
      if (key === 'verifies') {
        const reviewed: Record<string, string> = {};
        for (const v of after) {
          if (it.reviewed[v]) reviewed[v] = it.reviewed[v];
          else if (!before.includes(v)) {
            const req = index.byId.get(v);
            if (req) reviewed[v] = fingerprint(req);
          }
        }
        if (!same(reviewed, it.reviewed)) changes.reviewed = Object.keys(reviewed).length ? reviewed : undefined;
      }
    }
    if (Object.keys(changes).length) out.set(it.path, changes);
  }
  return out;
}
