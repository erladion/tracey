// The specification document: every requirement and test case with their text, the
// traceability matrix and coverage, as one HTML page to print or save as PDF.
import MarkdownIt from 'markdown-it';
import { byEvidence, coverage, itemLinks, linksOf, METHOD_LABEL, variantNames, verification, type Item, type ProjectIndex } from './model';
import { DOC_CSS, esc } from './report';
import type { TestRun } from './runs';
import { outcomeText, RESULT_MARK, resultMatrix, VERDICT_MARK, verdictSummary, verdictText } from './verdict';
import { customTypes, fieldsFor } from './config';
import { fieldText } from './fields';

// Raw HTML in the Markdown is shown as text, never run.
const md = MarkdownIt('commonmark', { html: false }).enable(['table', 'strikethrough']);

export interface SpecOptions {
  title: string;
  requirements: boolean;
  testcases: boolean;
  others?: boolean; // items of the types trace.yml declares (risks…); default: yes
  matrix: boolean;
  obsolete: boolean; // include obsolete items
  component: string | null; // only items tagged with it
  meta: [string, string][]; // shown under the title: repository, branch, commit…
  // Where an image in an item's text is loaded from (relative paths are the repository's).
  image: (itemPath: string, src: string) => string;
  // The Jira issues linked to an item, from every source (default: its front matter).
  issues?: (item: Item) => string[];
  // Show test results in the matrix, from these runs (see verdict.ts).
  results?: { runs: TestRun[]; description: string; oneRun: boolean } | null;
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
  const others = o.others === false ? [] : customTypes(index.config).map((t) => ({ t, items: index.items.filter((i) => i.kind === t.key && keep(i)) })).filter((x) => x.items.length);
  // Only links between items in the document.
  const suspect = coverage(index).suspect.filter((l) => keep(l.req) && keep(l.test));
  const { covered, exempt } = verification(index);
  // A requirement without test cases of its own: how it's covered, or that it isn't.
  const otherwise = (it: Item, down: Item[]) =>
    covered.get(it.id) === 'evidence'
      ? `<span class="muted">${esc(it.verification)}: ${esc(it.evidence.join(', '))}</span>`
      : down.length && covered.has(it.id)
        ? '<span class="muted">its refinements</span>'
        : exempt.has(it.id)
          ? '<span class="muted">needs no verification</span>'
          : `<span class="pill gap">${byEvidence(it.verification) ? 'no evidence' : 'no test cases'}</span>`;
  const anchor = (id: string) => `i-${id.replace(/[^\w-]/g, '_')}`;
  const ref = (id: string) => (index.byId.get(id) && keep(index.byId.get(id)!) ? `<a class="mono" href="#${anchor(id)}">${esc(id)}</a>` : `<span class="mono">${esc(id)}</span>`);
  const fields = (it: Item) => {
    const rows: [string, string][] = [['Status', statusPill(it.status)]];
    if (it.variants.length) rows.push(['Variants', esc(variantNames(index.config, it))]);
    if (it.components.length) rows.push(['Components', esc(it.components.map((c) => index.config.components.find((x) => x.key === c)?.name ?? c).join(', '))]);
    const issues = o.issues ? o.issues(it) : it.jira;
    if (issues.length) rows.push(['Jira', esc(issues.join(', '))]);
    for (const f of fieldsFor(index.config, it.kind)) if (fieldText(it.data[f.key])) rows.push([esc(f.name), esc(fieldText(it.data[f.key]))]);
    if (it.refines.length) rows.push(['Refines', it.refines.map(ref).join(', ')]);
    const down = (index.refinedBy.get(it.id) ?? []).filter(keep);
    if (down.length) rows.push(['Refined by', down.map((c) => ref(c.id)).join(', ')]);
    if (it.kind === 'requirement' && it.verification !== 'test') rows.push(['Verification', esc(METHOD_LABEL[it.verification])]);
    if (it.evidence.length) rows.push(['Evidence', esc(it.evidence.join(', '))]);
    // Links of the declared types, both ways.
    const declared = itemLinks(index, it);
    const mark = (state: string) => (state === 'suspect' ? ' <span class="pill suspect">changed since review</span>' : '');
    for (const def of index.config.links.filter((l) => !l.builtIn)) {
      const out = (it.links[def.key] ?? []).map((id) => ref(id) + mark(declared.out.find((l) => l.def === def && l.to.id === id)?.state ?? ''));
      if (out.length) rows.push([esc(def.name), out.join(', ')]);
      const into = declared.in.filter((l) => l.def === def && keep(l.from));
      if (into.length) rows.push([esc(def.reverse), into.map((l) => ref(l.from.id) + mark(l.state)).join(', ')]);
    }
    if (it.kind === 'testcase') rows.push(['Verifies', it.verifies.map(ref).join(', ') || '<span class="muted">nothing</span>']);
    else if (it.kind === 'requirement') {
      const t = linksOf(index, it);
      rows.push(['Verified by', t.map((l) => ref(l.test.id) + (l.state === 'suspect' ? ' <span class="pill suspect">changed since review</span>' : '')).join(', ') || otherwise(it, down)]);
    }
    return `<table class="fields">${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>`;
  };
  const section = (it: Item) => `<section class="item" id="${anchor(it.id)}">
<h3><span class="mono">${esc(it.id)}</span> ${esc(it.title)}</h3>
${fields(it)}
<div class="prose">${body(it, o.image)}</div>
</section>`;

  const live = reqs.filter((r) => r.status !== 'obsolete' && !exempt.has(r.id)); // the ones needing verification
  const tested = live.filter((r) => covered.has(r.id)); // by a test case, evidence, or through refinements
  const toc = [
    o.requirements && reqs.length ? `<li><a href="#requirements">Requirements</a> (${reqs.length})</li>` : '',
    o.testcases && tests.length ? `<li><a href="#testcases">Test cases</a> (${tests.length})</li>` : '',
    ...others.map(({ t, items }) => `<li><a href="#type-${t.key}">${esc(t.plural)}</a> (${items.length})</li>`),
    o.matrix && reqs.length ? `<li><a href="#matrix">Traceability matrix</a></li>` : '',
  ].join('');

  const rows = resultMatrix(index, o.results?.runs ?? [], keep);
  const matrixHtml = () => {
    const res = o.results;
    const head = res
      ? `<p class="muted">Results: ${esc(res.description)}. A requirement is verified when all of its test cases passed.</p><p><b>${esc(verdictSummary(rows))}</b></p>`
      : '';
    const testCell = (l: (typeof rows)[number]['links'][number]) =>
      res
        ? `<div>${ref(l.test.id)} <span class="res ${l.outcome.result}">${RESULT_MARK[l.outcome.result]} ${esc(outcomeText(l.outcome, res.oneRun))}</span>${l.state === 'suspect' ? ' ⚠' : ''}</div>`
        : ref(l.test.id) + (l.state === 'suspect' ? ' ⚠' : '');
    const body = rows
      .map((row) => {
        const { req, links, verdict } = row;
        const tests = links.length ? links.map(testCell).join(res ? '' : ', ') : req.status === 'obsolete' ? '—' : otherwise(req, index.refinedBy.get(req.id) ?? []);
        const v = res ? `<td>${verdict ? `<span class="verdict ${verdict}">${VERDICT_MARK[verdict]} ${esc(verdictText(row))}</span>` : esc(verdictText(row)) || '—'}</td>` : '';
        return `<tr><td>${ref(req.id)} ${esc(req.title)}</td><td>${esc(req.status)}</td>${v}<td>${tests}</td></tr>`;
      })
      .join('');
    const suspectNote = rows.some((r) => r.links.some((l) => l.state === 'suspect')) ? '<p class="muted small">⚠ The requirement changed after the link was last reviewed.</p>' : '';
    return `<h2 id="matrix">Traceability matrix</h2>${head}<table class="matrix"><tr><th>Requirement</th><th>Status</th>${res ? '<th>Verdict</th>' : ''}<th>Test cases</th></tr>${body}</table>${suspectNote}`;
  };

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
.matrix td{font-size:13px}.small{font-size:12px}
.res,.verdict{white-space:nowrap}.res.passed,.verdict.verified{color:var(--ok)}.res.failed,.verdict.failing,.verdict.no-tests{color:var(--bad);font-weight:600}
.res.blocked,.verdict.blocked{color:var(--warn);font-weight:600}.res.not-run,.verdict.partial,.verdict.not-run{color:var(--muted)}
@media print{.item{break-inside:auto}.item h3{break-after:avoid}#testcases,#matrix{break-before:page}}
</style></head><body><main>
<div class="cover keep">
<h1>${esc(o.title)}</h1>
<table class="meta">${[...o.meta, ['Generated', generated.toLocaleString()] as [string, string]].map(([k, v]) => `<tr><td>${esc(k)}</td><td${/commit/i.test(k) ? ' class="mono"' : ''}>${esc(v)}</td></tr>`).join('')}</table>
<h2>Summary</h2>
<p>${live.length} requirements to verify, ${tested.length} of them covered (${live.length ? Math.round((tested.length / live.length) * 100) : 0}%)${reqs.some((r) => exempt.has(r.id)) ? `, and ${reqs.filter((r) => exempt.has(r.id)).length} needing no verification` : ''}; ${tests.length} test cases.
${suspect.length ? ` ${suspect.length} link${suspect.length === 1 ? '' : 's'} changed since review.` : ''}${o.results ? ` Test results: ${esc(verdictSummary(rows))}.` : ''}${o.component ? ` Only items in the component “${esc(index.config.components.find((c) => c.key === o.component)?.name ?? o.component)}”.` : ''}</p>
${toc ? `<h2>Contents</h2><ol class="toc">${toc}</ol>` : ''}
</div>
${o.requirements && reqs.length ? `<h2 id="requirements">Requirements</h2>${reqs.map(section).join('\n')}` : ''}
${o.testcases && tests.length ? `<h2 id="testcases">Test cases</h2>${tests.map(section).join('\n')}` : ''}
${others.map(({ t, items }) => `<h2 id="type-${t.key}">${esc(t.plural)}</h2>${items.map(section).join('\n')}`).join('\n')}
${o.matrix && reqs.length ? matrixHtml() : ''}
</main></body></html>
`;
}
