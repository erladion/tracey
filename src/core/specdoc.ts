// The specification document: every requirement and test case with their text, the
// traceability matrix and coverage, as one HTML page to print or save as PDF.
import MarkdownIt from 'markdown-it';
import { coverage, linksOf, variantNames, type Item, type ProjectIndex } from './model';
import { DOC_CSS, esc } from './report';

// Raw HTML in the Markdown is shown as text, never run.
const md = MarkdownIt('commonmark', { html: false }).enable(['table', 'strikethrough']);

export interface SpecOptions {
  title: string;
  requirements: boolean;
  testcases: boolean;
  matrix: boolean;
  obsolete: boolean; // include obsolete items
  component: string | null; // only items tagged with it
  meta: [string, string][]; // shown under the title: repository, branch, commit…
  // Where an image in an item's text is loaded from (relative paths are the repository's).
  image: (itemPath: string, src: string) => string;
  // The Jira issues linked to an item, from every source (default: its front matter).
  issues?: (item: Item) => string[];
}

function body(item: Item, image: SpecOptions['image']): string {
  const html = md.render(item.body);
  // Images: point relative paths at the repository.
  return html.replace(/<img src="([^"]*)"/g, (_m, src: string) => `<img src="${esc(/^(https?:|data:)/.test(src) ? src : image(item.path, src.replace(/&amp;/g, '&')))}"`);
}

const statusPill = (s: string) => `<span class="pill st">${esc(s || 'no status')}</span>`;

export function specHtml(index: ProjectIndex, o: SpecOptions, generated = new Date()): string {
  const keep = (i: Item) => (o.obsolete || i.status !== 'obsolete') && (!o.component || i.components.includes(o.component));
  const reqs = index.items.filter((i) => i.kind === 'requirement' && keep(i));
  const tests = index.items.filter((i) => i.kind === 'testcase' && keep(i));
  // Only links between items in the document.
  const suspect = coverage(index).suspect.filter((l) => keep(l.req) && keep(l.test));
  const anchor = (id: string) => `i-${id.replace(/[^\w-]/g, '_')}`;
  const ref = (id: string) => (index.byId.get(id) && keep(index.byId.get(id)!) ? `<a class="mono" href="#${anchor(id)}">${esc(id)}</a>` : `<span class="mono">${esc(id)}</span>`);
  const fields = (it: Item) => {
    const rows: [string, string][] = [['Status', statusPill(it.status)]];
    if (it.variants.length) rows.push(['Variants', esc(variantNames(index.config, it))]);
    if (it.components.length) rows.push(['Components', esc(it.components.map((c) => index.config.components.find((x) => x.key === c)?.name ?? c).join(', '))]);
    const issues = o.issues ? o.issues(it) : it.jira;
    if (issues.length) rows.push(['Jira', esc(issues.join(', '))]);
    if (it.kind === 'testcase') rows.push(['Verifies', it.verifies.map(ref).join(', ') || '<span class="muted">nothing</span>']);
    else {
      const t = linksOf(index, it);
      rows.push(['Verified by', t.map((l) => ref(l.test.id) + (l.state === 'suspect' ? ' <span class="pill suspect">changed since review</span>' : '')).join(', ') || '<span class="pill gap">no test cases</span>']);
    }
    return `<table class="fields">${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>`;
  };
  const section = (it: Item) => `<section class="item" id="${anchor(it.id)}">
<h3><span class="mono">${esc(it.id)}</span> ${esc(it.title)}</h3>
${fields(it)}
<div class="prose">${body(it, o.image)}</div>
</section>`;

  const live = reqs.filter((r) => r.status !== 'obsolete');
  const tested = live.filter((r) => linksOf(index, r).some((l) => l.test.status !== 'obsolete'));
  const toc = [
    o.requirements && reqs.length ? `<li><a href="#requirements">Requirements</a> (${reqs.length})</li>` : '',
    o.testcases && tests.length ? `<li><a href="#testcases">Test cases</a> (${tests.length})</li>` : '',
    o.matrix && reqs.length ? `<li><a href="#matrix">Traceability matrix</a></li>` : '',
  ].join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)}</title>
<style>${DOC_CSS}
h3{font-size:16px;margin:0 0 8px}
.item{padding:18px 0 14px;border-bottom:1px solid var(--line)}
.fields{width:auto;margin:0 0 10px}.fields td{padding:2px 14px 2px 0;border:0;font-size:13px}.fields td:first-child{color:var(--muted)}
.prose{font-size:14px}.prose>:first-child{margin-top:0}.prose img{max-width:100%}
.prose table{width:auto}.prose td,.prose th{border:1px solid var(--line)}
.prose pre{background:#f6f6f3;padding:10px 12px;border-radius:6px;white-space:pre-wrap;font-size:12.5px}
.prose code{font-family:ui-monospace,monospace;font-size:.9em}
.pill.st{background:#e6eefb;color:#1e3f8f;font-weight:500}.pill.gap{color:var(--bad);border:1px dashed #b85a1a}.pill.suspect{background:var(--badbg);color:var(--bad)}
.cover{padding:8px 0 24px}.toc li{margin:2px 0}
.matrix td{font-size:13px}
@media print{.item{break-inside:auto}.item h3{break-after:avoid}#testcases,#matrix{break-before:page}}
</style></head><body><main>
<div class="cover keep">
<h1>${esc(o.title)}</h1>
<table class="meta">${[...o.meta, ['Generated', generated.toLocaleString()] as [string, string]].map(([k, v]) => `<tr><td>${esc(k)}</td><td${/commit/i.test(k) ? ' class="mono"' : ''}>${esc(v)}</td></tr>`).join('')}</table>
<h2>Summary</h2>
<p>${live.length} requirements, ${tested.length} of them verified by a test case (${live.length ? Math.round((tested.length / live.length) * 100) : 0}%); ${tests.length} test cases.
${suspect.length ? ` ${suspect.length} link${suspect.length === 1 ? '' : 's'} changed since review.` : ''}${o.component ? ` Only items in the component “${esc(index.config.components.find((c) => c.key === o.component)?.name ?? o.component)}”.` : ''}</p>
${toc ? `<h2>Contents</h2><ol class="toc">${toc}</ol>` : ''}
</div>
${o.requirements && reqs.length ? `<h2 id="requirements">Requirements</h2>${reqs.map(section).join('\n')}` : ''}
${o.testcases && tests.length ? `<h2 id="testcases">Test cases</h2>${tests.map(section).join('\n')}` : ''}
${
  o.matrix && reqs.length
    ? `<h2 id="matrix">Traceability matrix</h2><table class="matrix"><tr><th>Requirement</th><th>Status</th><th>Test cases</th></tr>${reqs
        .map((r) => {
          const t = linksOf(index, r).filter((l) => keep(l.test));
          return `<tr><td>${ref(r.id)} ${esc(r.title)}</td><td>${esc(r.status)}</td><td>${t.length ? t.map((l) => ref(l.test.id) + (l.state === 'suspect' ? ' ⚠' : '')).join(', ') : '<span class="pill gap">no test cases</span>'}</td></tr>`;
        })
        .join('')}</table>`
    : ''
}
</main></body></html>
`;
}
