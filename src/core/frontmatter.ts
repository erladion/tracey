// YAML front matter: splitting it from the body, and changing fields in it while
// keeping everything else (comments, order, quoting, flow lists) as written.
import { parseDocument, isSeq, isMap, type Document } from 'yaml';

export interface Split {
  front: string | null; // the YAML between the fences, ending in a newline; null: none
  body: string;
}

const OPEN = /^﻿?---[ \t]*\n/;

// Expects \n line endings (see document.ts).
export function splitFrontMatter(text: string): Split {
  const open = OPEN.exec(text);
  if (!open) return { front: null, body: text };
  const rest = text.slice(open[0].length);
  const close = /^(?:---|\.\.\.)[ \t]*(?:\n|$)/m.exec(rest);
  if (!close) return { front: null, body: text };
  return { front: rest.slice(0, close.index), body: rest.slice(close.index + close[0].length) };
}

export function joinFrontMatter(front: string | null, body: string): string {
  if (front == null) return body;
  const f = front === '' || front.endsWith('\n') ? front : front + '\n';
  return `---\n${f}---\n${body}`;
}

export function readFrontMatter(front: string | null): { data: Record<string, unknown>; error: string | null } {
  if (front == null || !front.trim()) return { data: {}, error: null };
  const doc = parseDocument(front);
  if (doc.errors.length) return { data: {}, error: doc.errors[0].message.split('\n')[0] };
  const data = doc.toJS();
  return { data: data && typeof data === 'object' && !Array.isArray(data) ? data : {}, error: null };
}

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0);
}

// Sets (or, for undefined/empty values, removes) fields. Lists are written in flow
// style ([a, b]) unless the field was already a block list.
export function setFields(front: string | null, changes: Record<string, unknown>): string {
  const doc: Document = parseDocument(front ?? '');
  if (!isMap(doc.contents)) doc.contents = doc.createNode({}) as never;
  for (const [key, value] of Object.entries(changes)) {
    if (isEmpty(value)) {
      doc.delete(key);
      continue;
    }
    const existing = doc.get(key, true);
    if (Array.isArray(value)) {
      const flow = !(isSeq(existing) && !existing.flow);
      const node = doc.createNode(value, { flow });
      doc.set(key, node);
    } else if (typeof value === 'object') {
      doc.set(key, doc.createNode(value));
    } else {
      doc.set(key, value);
    }
  }
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false });
}

// Line endings: edit with \n, write back what the file had.
export function decodeText(text: string): { text: string; crlf: boolean } {
  const crlf = /\r\n/.test(text);
  return { text: crlf ? text.replace(/\r\n/g, '\n') : text, crlf };
}

export function encodeText(text: string, crlf: boolean): string {
  return crlf ? text.replace(/\n/g, '\r\n') : text;
}
