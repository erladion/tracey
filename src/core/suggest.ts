// Test cases for a Jira issue, by what it's about: the likeliest few by their words
// (BM25 over each test case's title, text, the requirements it verifies and its
// components), then a language model picks those that fit, saying why. Only test cases
// it was offered can come back, so it can't make up IDs.
import { isRunnable, type TraceConfig } from './config';
import type { Item, ProjectIndex } from './model';
import type { ChatMessage, JiraIssue } from '../shared/api';

// Words that say nothing about what a text is about.
const STOP = new Set(
  'a an and are as at be been but by can could did do does for from had has have how i if in into is it its may more must no not of on or our shall should so such than that the their then there these this those to was we were what when where which while who will with would you your after before also all any each every other only same some up out over under via per should step steps test tests verify verifies check checks expected result results'.split(
    ' ',
  ),
);

// Lower-case words, plural and -ing endings taken off, so "payments" finds "payment".
export function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((w) => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w))
    .map((w) => (w.length > 5 && w.endsWith('ing') ? w.slice(0, -3) : w.length > 3 && w.endsWith('ies') ? w.slice(0, -3) + 'y' : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}

export interface Candidate {
  item: Item;
  score: number;
  about: string; // a line on what it tests: the requirements it verifies, its components
}

export interface TestIndex {
  // The likeliest test cases for a text, best first: at most `k`, and only ones sharing words with it.
  search(text: string, k: number): Candidate[];
}

// What a test case is about, for the search and for the model: the requirements it
// verifies (by title) and its components.
function aboutOf(it: Item, index: ProjectIndex, config: TraceConfig): string {
  const reqs = it.verifies.map((id) => index.byId.get(id)).filter((r): r is Item => !!r);
  const comps = it.components.map((c) => config.components.find((x) => x.key === c)?.name ?? c);
  return [reqs.length ? `verifies ${reqs.map((r) => `${r.id} ${r.title}`).join('; ')}` : '', comps.length ? `components: ${comps.join(', ')}` : ''].filter(Boolean).join(' · ');
}

export function testIndex(index: ProjectIndex): TestIndex {
  const tests = index.items.filter((i) => isRunnable(index.config, i.kind) && i.status !== 'obsolete');
  // Each test case's words: its title counts three times, the requirements' titles twice.
  const docs = tests.map((it) => {
    const reqTitles = it.verifies.map((id) => index.byId.get(id)?.title ?? '').join(' ');
    const comps = it.components.map((c) => index.config.components.find((x) => x.key === c)?.name ?? c).join(' ');
    const ws = [...words(it.title), ...words(it.title), ...words(it.title), ...words(reqTitles), ...words(reqTitles), ...words(comps), ...words(it.body.slice(0, 3000))];
    const tf = new Map<string, number>();
    for (const w of ws) tf.set(w, (tf.get(w) ?? 0) + 1);
    return { item: it, tf, len: ws.length };
  });
  const df = new Map<string, number>();
  for (const d of docs) for (const w of d.tf.keys()) df.set(w, (df.get(w) ?? 0) + 1);
  const avg = docs.reduce((a, d) => a + d.len, 0) / Math.max(1, docs.length);
  const N = docs.length;
  const idf = (w: string) => {
    const n = df.get(w) ?? 0;
    return Math.log(1 + (N - n + 0.5) / (n + 0.5));
  };
  const K1 = 1.2;
  const B = 0.75;
  return {
    search(text, k) {
      const q = new Map<string, number>();
      for (const w of words(text)) q.set(w, (q.get(w) ?? 0) + 1);
      const scored: { d: (typeof docs)[number]; score: number }[] = [];
      for (const d of docs) {
        let score = 0;
        for (const [w, qn] of q) {
          const f = d.tf.get(w);
          if (!f) continue;
          score += Math.min(qn, 3) * idf(w) * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.len) / avg)));
        }
        if (score > 0) scored.push({ d, score });
      }
      scored.sort((a, b) => b.score - a.score || a.d.item.id.localeCompare(b.d.item.id));
      return scored.slice(0, k).map(({ d, score }) => ({ item: d.item, score, about: aboutOf(d.item, index, index.config) }));
    },
  };
}

// What's searched for an issue: its summary (twice: it says most), labels and description.
export const issueText = (issue: JiraIssue) => [issue.summary, issue.summary, issue.labels.join(' '), issue.description.slice(0, 4000)].join('\n');

export type { ChatMessage };

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).replace(/\s+\S*$/, '')} …` : s);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

// The question for the model: the issue, and the test cases it may choose from.
export function suggestPrompt(issue: JiraIssue, candidates: Candidate[]): ChatMessage[] {
  const list = candidates.map((c) => `- ${c.item.id}: ${oneLine(c.item.title)}${c.about ? ` (${oneLine(c.about)})` : ''}`).join('\n');
  return [
    {
      role: 'system',
      content:
        'You help a tester choose which existing test cases to run for a change. You are given a Jira issue describing the change, and a list of candidate test cases. ' +
        'Pick only the test cases that test what the issue changes or fixes; leave out ones that merely share words with it. Picking none is fine. ' +
        'Answer with JSON only, no other text: {"tests": [{"id": "<a test case ID from the list>", "why": "<one short sentence>"}]}',
    },
    {
      role: 'user',
      content: [
        `Jira issue ${issue.key}${issue.type ? ` (${issue.type})` : ''}: ${oneLine(issue.summary)}`,
        issue.labels.length ? `Labels: ${issue.labels.join(', ')}` : '',
        issue.description.trim() ? `Description:\n${clip(issue.description.trim(), 3000)}` : '',
        '',
        'Candidate test cases:',
        list,
      ]
        .filter((l, i) => l || i === 3)
        .join('\n'),
    },
  ];
}

export interface Suggestion {
  id: string;
  why: string;
}

// The model's answer as suggestions: the JSON in it (reasoning models write their thinking
// first), with only the offered test cases, each once. `dropped` counts IDs it made up.
export function readSuggestions(answer: string, offered: Set<string>): { suggestions: Suggestion[]; dropped: number; readable: boolean } {
  const text = stripThinking(answer).replace(/```(?:json)?/gi, '');
  let parsed: unknown = null;
  // The first JSON object or array that parses, from each opening brace in turn.
  for (let i = 0; i < text.length && parsed === null; i++) {
    if (text[i] !== '{' && text[i] !== '[') continue;
    const end = matchingClose(text, i);
    if (end < 0) continue;
    try {
      parsed = JSON.parse(text.slice(i, end + 1));
    } catch {
      parsed = null;
    }
  }
  if (parsed === null) return { suggestions: [], dropped: 0, readable: false };
  const list = Array.isArray(parsed) ? parsed : ((parsed as Record<string, unknown>).tests ?? (parsed as Record<string, unknown>).test_cases ?? (parsed as Record<string, unknown>).testcases);
  if (!Array.isArray(list)) return { suggestions: [], dropped: 0, readable: true };
  const out: Suggestion[] = [];
  let dropped = 0;
  const upper = new Map([...offered].map((id) => [id.toUpperCase(), id]));
  for (const x of list) {
    const rawId = typeof x === 'string' ? x : typeof x === 'object' && x ? String((x as Record<string, unknown>).id ?? '') : '';
    const id = upper.get(rawId.trim().toUpperCase());
    if (!id) {
      if (rawId.trim()) dropped++;
      continue;
    }
    if (out.some((s) => s.id === id)) continue;
    const why = typeof x === 'object' && x ? oneLine(String((x as Record<string, unknown>).why ?? (x as Record<string, unknown>).reason ?? '')) : '';
    out.push({ id, why: clip(why, 200) });
  }
  return { suggestions: out, dropped, readable: true };
}

// An answer without its thinking: whole <think> blocks, and everything up to a closing tag
// when the chat template opened the block in the prompt (as in Smith's think.ts).
export const stripThinking = (text: string) => text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*?<\/think>/i, '').trim();

// How many test cases to offer per issue: as set, or from the model's context window, at
// about 50 tokens a test case and half the window for them (the rest for the issue, the
// instructions and the answer). Between 30 and 150: more crowds the model's judgement.
export function candidateCount(setting: number, contextSize: number | null): number {
  if (setting > 0) return Math.min(500, Math.round(setting));
  if (!contextSize) return 30;
  return Math.max(20, Math.min(150, Math.floor((contextSize / 2 - 3000) / 50)));
}

// Where the bracket opened at `start` closes, minding strings; -1 if it doesn't.
function matchingClose(s: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
