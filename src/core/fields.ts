// Front-matter fields Tracey has no editor for (priority, safety-level, doors, from an
// import or written by hand): kept as they are, shown read-only, and searchable.
//
//   priority:high      items whose priority contains "high"
//   doors:Payments     a field holding an object or list matches on any part of it
//   retry timeout      every word somewhere in the ID, title, text or any field
import type { Kind } from './config';
import type { Item } from './model';

// The fields Tracey edits itself; `reviewed` is its bookkeeping, never shown.
const OWN: Record<Kind, Set<string>> = {
  requirement: new Set(['id', 'title', 'status', 'components', 'variants', 'jira', 'reviewed']),
  testcase: new Set(['id', 'title', 'status', 'components', 'variants', 'jira', 'reviewed', 'verifies', 'estimate']),
};

export const isOwnField = (kind: Kind, key: string) => OWN[kind].has(key);

// The other fields, in the file's order, without empty ones.
export function otherFields(item: Pick<Item, 'kind' | 'data'>): [string, unknown][] {
  return Object.entries(item.data).filter(([k, v]) => !OWN[item.kind].has(k) && v != null && v !== '');
}

// A field's value as text: lists joined, objects as "key: value" pairs.
export function fieldText(v: unknown): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(fieldText).join(', ');
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object')
    return Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `${k}: ${fieldText(x)}`)
      .join(' · ');
  return String(v);
}

const FIELD_TERM = /^([a-z][\w.-]*):(.+)$/i;

// Whether an item matches a search: every word must be found, `field:value` in that field.
export function matchesSearch(item: Item, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const fields = Object.entries(item.data).filter(([k]) => k !== 'reviewed');
  const everywhere = [item.id, item.title, item.body, ...fields.map(([, v]) => fieldText(v))].join('\n').toLowerCase();
  return words.every((w) => {
    const m = FIELD_TERM.exec(w);
    if (m) {
      const key = m[1];
      const hit = fields.find(([k]) => k.toLowerCase() === key);
      if (hit) return fieldText(hit[1]).toLowerCase().includes(m[2]);
      // Not a field this item has: maybe just text with a colon in it.
    }
    return everywhere.includes(w);
  });
}
