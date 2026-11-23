// A test case's steps: the numbered list under its "Steps" heading or **Steps** label
// (also "Test steps", "Procedure"), as recorded one by one in a test run. The rest of the text (Expected,
// notes) is everything else.
import MarkdownIt from 'markdown-it';

const md = MarkdownIt('commonmark');
// A heading, or (in a Sphinx need, which can't hold headings) a bold label on its own line.
const HEADING = /^\s{0,3}(#{1,6}\s+|\*\*)(?:test\s+)?(?:steps|procedure)\b[^*]*(?:\*\*:?)?\s*$/i;
const LABEL = /^\s{0,3}\*\*[^*]+\*\*:?\s*$/;

export interface Steps {
  steps: string[]; // each step's text (inline Markdown, one line)
  rest: string; // the text without the Steps section
}

export function stepsOf(body: string): Steps {
  const lines = body.split('\n');
  const start = lines.findIndex((l) => HEADING.test(l));
  if (start < 0) return { steps: [], rest: body };
  const mark = HEADING.exec(lines[start])![1].trim();
  const level = mark === '**' ? 7 : mark.length; // a label ends at the next label or any heading
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const h = /^\s{0,3}(#{1,6})\s/.exec(lines[i]);
    if ((h && h[1].length <= level) || (level === 7 && LABEL.test(lines[i]))) {
      end = i;
      break;
    }
  }
  const section = lines.slice(start + 1, end).join('\n');
  // The first numbered list in the section, its items at the top level.
  const tokens = md.parse(section, {});
  const steps: string[] = [];
  let depth = 0;
  let inList = false;
  let item: string[] | null = null;
  for (const t of tokens) {
    if (t.type === 'ordered_list_open' && depth === 0 && !inList && !steps.length) inList = true;
    if (t.type.endsWith('_list_open')) depth++;
    if (t.type.endsWith('_list_close')) {
      depth--;
      if (inList && depth === 0) break;
    }
    if (!inList) continue;
    if (t.type === 'list_item_open' && depth === 1) item = [];
    else if (t.type === 'inline' && item && depth === 1) item.push(t.content.replace(/\s*\n\s*/g, ' '));
    else if (t.type === 'list_item_close' && depth === 1 && item) {
      steps.push(item.join(' ').trim());
      item = null;
    }
  }
  if (!steps.length) return { steps: [], rest: body };
  const rest = [...lines.slice(0, start), ...lines.slice(end)].join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { steps, rest };
}
