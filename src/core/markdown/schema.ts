// ProseMirror schema for plain Markdown (CommonMark + GFM tables and strikethrough).
// Node and mark names follow prosemirror-markdown's, so its serializer applies.
import { Schema, type NodeSpec, type MarkSpec } from 'prosemirror-model';
import { tableNodes } from 'prosemirror-tables';

const table = tableNodes({
  tableGroup: 'block',
  // Markdown table cells hold one line of inline content.
  cellContent: 'inline*',
  cellAttributes: {
    align: {
      default: null,
      getFromDOM: (dom) => {
        const a = dom.style.textAlign;
        return a === 'left' || a === 'center' || a === 'right' ? a : null;
      },
      setDOMAttr: (value, attrs) => {
        if (value) attrs.style = `text-align: ${value}`;
      },
    },
  },
});

const nodes: Record<string, NodeSpec> = {
  doc: { content: 'block+' },

  paragraph: {
    group: 'block',
    content: 'inline*',
    parseDOM: [{ tag: 'p' }],
    toDOM: () => ['p', 0],
  },

  heading: {
    group: 'block',
    content: 'inline*',
    defining: true,
    attrs: { level: { default: 1 } },
    parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({ tag: `h${level}`, attrs: { level } })),
    toDOM: (node) => [`h${node.attrs.level}`, 0],
  },

  blockquote: {
    group: 'block',
    content: 'block+',
    defining: true,
    parseDOM: [{ tag: 'blockquote' }],
    toDOM: () => ['blockquote', 0],
  },

  code_block: {
    group: 'block',
    content: 'text*',
    marks: '',
    code: true,
    defining: true,
    attrs: { params: { default: '' } },
    parseDOM: [{ tag: 'pre', preserveWhitespace: 'full', getAttrs: (dom) => ({ params: (dom as HTMLElement).getAttribute('data-params') ?? '' }) }],
    toDOM: (node) => ['pre', node.attrs.params ? { 'data-params': node.attrs.params } : {}, ['code', 0]],
  },

  horizontal_rule: {
    group: 'block',
    parseDOM: [{ tag: 'hr' }],
    toDOM: () => ['hr'],
  },

  bullet_list: {
    group: 'block',
    content: 'list_item+',
    attrs: { tight: { default: true }, bullet: { default: '-' } },
    parseDOM: [{ tag: 'ul', getAttrs: (dom) => ({ tight: (dom as HTMLElement).getAttribute('data-tight') !== 'false' }) }],
    toDOM: (node) => ['ul', { 'data-tight': String(node.attrs.tight) }, 0],
  },

  ordered_list: {
    group: 'block',
    content: 'list_item+',
    attrs: { order: { default: 1 }, tight: { default: true } },
    parseDOM: [
      {
        tag: 'ol',
        getAttrs: (dom) => {
          const el = dom as HTMLElement;
          return { order: el.hasAttribute('start') ? Number(el.getAttribute('start')) || 1 : 1, tight: el.getAttribute('data-tight') !== 'false' };
        },
      },
    ],
    toDOM: (node) => ['ol', { start: node.attrs.order === 1 ? null : node.attrs.order, 'data-tight': String(node.attrs.tight) }, 0],
  },

  list_item: {
    content: 'paragraph block*',
    defining: true,
    parseDOM: [{ tag: 'li' }],
    toDOM: () => ['li', 0],
  },

  // Raw HTML blocks are kept as written and shown as source.
  html_block: {
    group: 'block',
    content: 'text*',
    marks: '',
    code: true,
    defining: true,
    parseDOM: [{ tag: 'pre.html-block', preserveWhitespace: 'full' }],
    toDOM: () => ['pre', { class: 'html-block' }, ['code', 0]],
  },

  ...table,

  text: { group: 'inline' },

  image: {
    inline: true,
    group: 'inline',
    draggable: true,
    attrs: { src: {}, alt: { default: null }, title: { default: null } },
    parseDOM: [
      {
        tag: 'img[src]',
        getAttrs: (dom) => {
          const el = dom as HTMLElement;
          return { src: el.getAttribute('data-src') ?? el.getAttribute('src'), title: el.getAttribute('title'), alt: el.getAttribute('alt') };
        },
      },
    ],
    toDOM: (node) => ['img', { src: node.attrs.src, 'data-src': node.attrs.src, alt: node.attrs.alt, title: node.attrs.title }],
  },

  hard_break: {
    inline: true,
    group: 'inline',
    selectable: false,
    parseDOM: [{ tag: 'br' }],
    toDOM: () => ['br'],
  },

  // A line break inside a paragraph in the source: shown as a space (as Markdown
  // renders it), written back as the line break it was, so wrapped text stays wrapped.
  soft_break: {
    inline: true,
    group: 'inline',
    selectable: false,
    parseDOM: [{ tag: 'span.soft-break' }],
    toDOM: () => ['span', { class: 'soft-break' }, ' '],
  },

  // Inline HTML (<kbd>, <br>, …) kept as written.
  html_inline: {
    inline: true,
    group: 'inline',
    atom: true,
    attrs: { html: { default: '' } },
    parseDOM: [{ tag: 'span.html-inline', getAttrs: (dom) => ({ html: (dom as HTMLElement).textContent ?? '' }) }],
    toDOM: (node) => ['span', { class: 'html-inline' }, node.attrs.html],
  },
};

const marks: Record<string, MarkSpec> = {
  em: {
    parseDOM: [{ tag: 'i' }, { tag: 'em' }, { style: 'font-style=italic' }],
    toDOM: () => ['em'],
  },
  strong: {
    parseDOM: [{ tag: 'strong' }, { tag: 'b', getAttrs: (node) => (node as HTMLElement).style.fontWeight !== 'normal' && null }, { style: 'font-weight=bold' }],
    toDOM: () => ['strong'],
  },
  strike: {
    parseDOM: [{ tag: 's' }, { tag: 'del' }, { tag: 'strike' }, { style: 'text-decoration=line-through' }],
    toDOM: () => ['s'],
  },
  link: {
    attrs: { href: {}, title: { default: null } },
    inclusive: false,
    parseDOM: [{ tag: 'a[href]', getAttrs: (dom) => ({ href: (dom as HTMLElement).getAttribute('href'), title: (dom as HTMLElement).getAttribute('title') }) }],
    toDOM: (node) => ['a', { href: node.attrs.href, title: node.attrs.title, rel: 'noopener noreferrer' }],
  },
  code: {
    code: true,
    excludes: '_',
    parseDOM: [{ tag: 'code' }],
    toDOM: () => ['code'],
  },
};

export const schema = new Schema({ nodes, marks });
