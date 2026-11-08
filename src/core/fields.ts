// Front-matter fields beyond Tracey's own. Those declared under `fields:` in trace.yml
// are edited like the rest; the others (from an import, or written by hand) are kept
// as they are, shown read-only, and searchable.
//
//   priority:high      items whose priority contains "high"
//   doors:Payments     a field holding an object or list matches on any part of it
//   retry timeout      every word somewhere in the ID, title, text or any field
import type { FieldDef, Kind, TraceConfig } from './config';
import type { Item } from './model';

// The fields Tracey edits itself; `reviewed` is its bookkeeping, never shown.
const OWN: Record<Kind, Set<string>> = {
  requirement: new Set(['id', 'title', 'status', 'components', 'variants', 'jira', 'reviewed', 'refines', 'verification', 'evidence']),
  testcase: new Set(['id', 'title', 'status', 'components', 'variants', 'jira', 'reviewed', 'verifies', 'estimate']),
};

export const isOwnField = (kind: Kind, key: string) => OWN[kind].has(key);

// The fields neither Tracey nor trace.yml knows, in the file's order, without empty ones.
export function otherFields(item: Pick<Item, 'kind' | 'data'>, config?: TraceConfig): [string, unknown][] {
  const declared = new Set((config?.fields ?? []).filter((f) => f.kinds.includes(item.kind)).map((f) => f.key));
  return Object.entries(item.data).filter(([k, v]) => !OWN[item.kind].has(k) && !declared.has(k) && v != null && v !== '');
}

// A declared field's value as a list (choices, list) or a single text (the rest).
export const listValue = (v: unknown): string[] => (v == null || v === '' ? [] : Array.isArray(v) ? v.map((x) => fieldText(x)).filter(Boolean) : [fieldText(v)]);

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// What's wrong with a declared field's value, if anything.
export function fieldIssue(def: FieldDef, v: unknown): string | null {
  if (v == null || v === '' || (Array.isArray(v) && !v.length)) return null;
  const shown = fieldText(v);
  switch (def.type) {
    case 'number':
      return typeof v === 'number' ? null : `“${shown}”, which isn't a number`;
    case 'date':
      return DATE.test(shown) && !Number.isNaN(Date.parse(shown)) ? null : `“${shown}”, which isn't a date like 2026-11-07`;
    case 'choice':
      if (Array.isArray(v)) return `several values (${shown}), but it takes one of: ${def.values.join(', ')}`;
      return def.values.includes(shown) ? null : `“${shown}”, which isn't one of: ${def.values.join(', ')}`;
    case 'choices': {
      const bad = listValue(v).filter((x) => !def.values.includes(x));
      return bad.length ? `${bad.map((b) => `“${b}”`).join(', ')}, not among: ${def.values.join(', ')}` : null;
    }
    case 'text':
      return typeof v === 'object' ? `a ${Array.isArray(v) ? 'list' : 'nested value'}, but it takes one line of text` : null;
    default:
      return null;
  }
}

// A field's value from what someone typed: a number for number fields, trimmed text
// otherwise; empty removes it.
export function fieldInput(def: FieldDef, text: string): unknown {
  const t = text.trim();
  if (!t) return undefined;
  if (def.type === 'number') return Number.isFinite(Number(t.replace(',', '.'))) ? Number(t.replace(',', '.')) : t;
  return t;
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
