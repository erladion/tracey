import { describe, expect, it } from 'vitest';
import { parseBody, serializeBody, serializeNode } from '../src/core/markdown/markdown';
import { schema } from '../src/core/markdown/schema';

const sample = `When the payment gateway times out, the system retries
up to 3 times with increasing delay before failing.

## Steps
1. Configure the gateway stub to time out.
2. Submit a payment.

* star bullets
* stay

| Attempt | Delay |
|:--|--:|
| 1 | 1 s |
| 2 | \`a|b\` |

<div align="center">raw html</div>

Some ~~struck~~ **bold** _em_ text with <kbd>Ctrl</kbd> and [a link](https://example.com).
[ref]: https://example.com

\`\`\`js
const x = 1;
\`\`\`
`;

describe('markdown round trip', () => {
  it('writes an unedited document back byte for byte', () => {
    const p = parseBody(sample);
    expect(serializeBody(p.doc, p)).toBe(sample);
  });

  it('only re-serializes the edited block', () => {
    const p = parseBody(sample);
    const doc = p.doc.copy(p.doc.content.replaceChild(0, schema.node('paragraph', null, [schema.text('Changed.')])));
    const out = serializeBody(doc, p);
    expect(out).toBe('Changed.\n\n' + sample.slice(sample.indexOf('## Steps')));
  });

  it('serializes tables, strikethrough and inline html', () => {
    const p = parseBody('| a | b |\n|---|:-:|\n| ~~x~~ | <b>y</b> |\n');
    const table = p.doc.firstChild!;
    expect(table.type.name).toBe('table');
    expect(serializeNode(table)).toBe('| a | b |\n| --- | :---: |\n| ~~x~~ | <b>y</b> |\n');
  });

  it('separates new blocks with a blank line', () => {
    const p = parseBody('# Title\nText\n');
    const doc = p.doc.copy(p.doc.content.addToEnd(schema.node('paragraph', null, [schema.text('More')])));
    expect(serializeBody(doc, p)).toBe('# Title\nText\n\nMore\n');
  });

  it('handles an empty body', () => {
    const p = parseBody('');
    expect(serializeBody(p.doc, p)).toBe('');
  });
});

describe('soft line breaks', () => {
  it('keep wrapped lines when the paragraph is edited', () => {
    const p = parseBody('One line\nand the next.\n');
    const para = p.doc.firstChild!;
    const edited = para.copy(para.content.append(schema.node('paragraph', null, [schema.text(' More.')]).content));
    const doc = p.doc.copy(p.doc.content.replaceChild(0, edited));
    expect(serializeBody(doc, p)).toBe('One line\nand the next. More.\n');
  });

  it('leaves out empty paragraphs', () => {
    const p = parseBody('A\n');
    const doc = p.doc.copy(p.doc.content.addToStart(schema.node('paragraph')).addToEnd(schema.node('paragraph', null, [schema.text('B')])));
    expect(serializeBody(doc, p)).toBe('A\n\nB\n');
  });
});
