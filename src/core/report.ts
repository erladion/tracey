// A test run's report, as Markdown (to keep in the repository) or as a standalone HTML
// page (to send, or print to PDF).
import type { Item, ProjectIndex } from './model';
import { estimateText, formatDuration, runEstimate } from './estimate';
import { releaseOf, stepProblems, summarize, type Result, type RunCase, type TestRun } from './runs';
import { stepsOf } from './steps';

const LABEL: Record<Result, string> = { passed: 'Passed', failed: 'Failed', blocked: 'Blocked', 'not-run': 'Not run' };

interface Group {
  req: Item | null; // null: cases verifying no requirement in the run
  cases: { c: RunCase; item: Item | undefined }[];
}

// Cases grouped under the requirements they verify (a case can appear under several).
function groups(run: TestRun, index: ProjectIndex): Group[] {
  const byReq = new Map<string, Group>();
  const loose: Group = { req: null, cases: [] };
  for (const c of run.cases) {
    const item = index.byId.get(c.id);
    const reqs = (item?.verifies ?? []).map((v) => index.byId.get(v)).filter((r): r is Item => !!r);
    if (!reqs.length) loose.cases.push({ c, item });
    for (const r of reqs) {
      if (!byReq.has(r.id)) byReq.set(r.id, { req: r, cases: [] });
      byReq.get(r.id)!.cases.push({ c, item });
    }
  }
  const out = [...byReq.values()].sort((a, b) => a.req!.id.localeCompare(b.req!.id, undefined, { numeric: true }));
  return loose.cases.length ? [...out, loose] : out;
}

function verdict(g: Group): Result {
  const rs = g.cases.map((x) => x.c.result);
  if (rs.includes('failed')) return 'failed';
  if (rs.includes('blocked')) return 'blocked';
  if (rs.includes('not-run')) return 'not-run';
  return 'passed';
}

function header(run: TestRun, index?: ProjectIndex): [string, string][] {
  const rows: [string, string][] = [];
  const release = releaseOf(run);
  if (release) rows.push(['Release', release]);
  if (run.variant) rows.push(['Variant', index?.config.variants.find((v) => v.key === run.variant)?.name ?? run.variant]);
  if (run.from || run.to) rows.push(['Versions', `${run.from ?? '?'} → ${run.to ?? '?'}`]);
  if (run.fixVersion) rows.push(['Jira fix version', run.fixVersion]);
  if (run.codeCommit) rows.push(['Code commit', run.codeCommit]);
  if (run.commitCount != null) rows.push(['Commits in range', String(run.commitCount)]);
  if (run.requirementsCommit) rows.push(['Requirements commit', run.requirementsCommit]);
  if (run.issues.length) rows.push(['Jira issues', run.issues.join(', ')]);
  if (index) {
    const e = runEstimate(run, index);
    if (e.total.counted) rows.push(['Estimated time', `${estimateText(e.total)}; ${formatDuration(e.left.minutes)} of it not run yet`]);
  }
  rows.push(['Run created', run.created || '—']);
  const testers = [...new Set(run.cases.map((c) => c.tester).filter(Boolean))];
  if (testers.length) rows.push(['Testers', testers.join(', ')]);
  return rows;
}

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);

// What went wrong at which step, with the step's text: "Step 3 (Submit a payment) failed: …".
const problemsOf = (c: RunCase, index: ProjectIndex) => {
  const it = index.byId.get(c.id);
  return stepProblems(c, it ? stepsOf(it.body).steps : []);
};

export function reportMarkdown(run: TestRun, index: ProjectIndex, generated = new Date()): string {
  const s = summarize(run);
  const cell = (t: string) => t.replace(/\|/g, '\\|').replace(/\n+/g, ' ');
  const out: string[] = [`# Test report: ${run.name}`, ''];
  out.push('| | |', '| --- | --- |');
  for (const [k, v] of header(run, index)) out.push(`| ${k} | ${cell(v)} |`);
  out.push(`| Report generated | ${generated.toISOString().slice(0, 16).replace('T', ' ')} |`, '');
  out.push('## Summary', '');
  out.push(`${s.total} test cases: **${s.passed} passed**, **${s.failed} failed**, ${s.blocked} blocked, ${s.notRun} not run (${pct(s.done, s.total)}% executed, ${pct(s.passed, s.total)}% passed).`, '');

  const bad = run.cases.filter((c) => c.result === 'failed' || c.result === 'blocked');
  if (bad.length) {
    out.push('## Failed and blocked', '');
    for (const c of bad) {
      const it = index.byId.get(c.id);
      out.push(`- **${c.id}** ${it?.title ?? ''}: ${LABEL[c.result]}${c.tester ? ` (${c.tester}, ${c.date})` : ''}${c.note ? `. ${c.note.replace(/\n+/g, '; ')}` : ''}`);
      for (const p of problemsOf(c, index)) out.push(`  - ${p}`);
    }
    out.push('');
  }

  out.push('## By requirement', '', '| Requirement | Result | Test cases |', '| --- | --- | --- |');
  for (const g of groups(run, index))
    out.push(
      `| ${g.req ? `${g.req.id} ${cell(g.req.title)}` : '(no requirement)'} | ${LABEL[verdict(g)]} | ${g.cases.map(({ c }) => `${c.id}: ${LABEL[c.result]}`).join(', ')} |`,
    );
  out.push('');

  out.push('## Test cases', '', '| Test case | Result | Tester | Date | Assigned to | Note | Why in this run |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const c of run.cases) {
    const it = index.byId.get(c.id);
    const note = [...problemsOf(c, index), c.note].filter(Boolean).join('; ');
    out.push(`| ${c.id} ${cell(it?.title ?? '(deleted)')} | ${LABEL[c.result]} | ${cell(c.tester)} | ${c.date} | ${cell(c.assignee)} | ${cell(note)} | ${cell(c.reason.join('; '))} |`);
  }
  out.push('');

  const g = run.gaps;
  if (g.requirementsWithoutTests.length || g.componentsWithoutTests.length || g.issuesWithoutRequirement.length) {
    out.push('## Not covered by this run', '');
    if (g.requirementsWithoutTests.length) out.push(`- Requirements affected but with no test cases: ${g.requirementsWithoutTests.join(', ')}`);
    if (g.componentsWithoutTests.length) out.push(`- Components changed but with no test cases: ${g.componentsWithoutTests.join(', ')}`);
    if (g.issuesWithoutRequirement.length) out.push(`- Jira issues in this release linked to no requirement or test case: ${g.issuesWithoutRequirement.join(', ')}`);
    out.push('');
  }
  return out.join('\n');
}

// Styles shared by the report and the specification document, on screen and on paper.
export const DOC_CSS = `
:root{--fg:#1a1a1a;--muted:#5c5c58;--line:#e4e4df;--accent:#2453c7;--ok:#0f6e56;--okbg:#dff3ec;--bad:#8a3b00;--badbg:#fdebd8;--warnbg:#fff4cc;--warn:#7a5a00}
body{margin:0;background:#fff;color:var(--fg);font:14px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif}
main{max-width:980px;margin:0 auto;padding:40px 24px 64px}
h1{font-size:28px;margin:0 0 16px}h2{font-size:19px;margin:32px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--line)}
table{width:100%;border-collapse:collapse;margin:8px 0}th,td{text-align:left;vertical-align:top;padding:7px 10px;border-bottom:1px solid var(--line)}
th{font-size:12px;color:var(--muted);font-weight:600}
.meta td:first-child{color:var(--muted);width:180px}.mono{font-family:ui-monospace,'JetBrains Mono',monospace;font-size:12.5px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin:12px 0}
.tile{border:1px solid var(--line);border-radius:10px;padding:12px 14px}.tile b{display:block;font-size:26px}
.bar{display:flex;height:10px;border-radius:5px;overflow:hidden;background:#f0f0ec;margin:6px 0 4px}
.bar .passed{background:var(--ok)}.bar .failed{background:#c76a2a}.bar .blocked{background:#d9a400}
.pill{display:inline-block;padding:1px 9px;border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap}
.pill.passed{background:var(--okbg);color:var(--ok)}.pill.failed{background:var(--badbg);color:var(--bad)}
.pill.blocked{background:var(--warnbg);color:var(--warn)}.pill.not-run{background:#f0f0ec;color:var(--muted)}
.muted{color:var(--muted)}.nowrap{white-space:nowrap}ul{padding-left:20px}.step-problem{color:var(--bad);font-weight:600}
@page{size:A4;margin:16mm 14mm 18mm;@bottom-center{content:counter(page) " / " counter(pages);font:9px system-ui,sans-serif;color:#888}}
@media print{main{padding:0;max-width:none}h1,h2,h3{break-after:avoid}tr,.tile,.keep{break-inside:avoid}a{color:inherit;text-decoration:none}}
`;

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// A note as HTML: its lines kept, and the steps that went wrong before it.
const noteHtml = (c: RunCase, index: ProjectIndex) =>
  [...problemsOf(c, index).map((p) => `<span class="step-problem">${esc(p)}</span>`), c.note ? esc(c.note).replace(/\n/g, '<br>') : ''].filter(Boolean).join('<br>');

export function reportHtml(run: TestRun, index: ProjectIndex, generated = new Date()): string {
  const s = summarize(run);
  const pill = (r: Result) => `<span class="pill ${r}">${LABEL[r]}</span>`;
  const bad = run.cases.filter((c) => c.result === 'failed' || c.result === 'blocked');
  const g = run.gaps;
  const gaps = [
    g.requirementsWithoutTests.length ? `<li>Requirements affected but with no test cases: ${esc(g.requirementsWithoutTests.join(', '))}</li>` : '',
    g.componentsWithoutTests.length ? `<li>Components changed but with no test cases: ${esc(g.componentsWithoutTests.join(', '))}</li>` : '',
    g.issuesWithoutRequirement.length ? `<li>Jira issues in this release linked to no requirement or test case: ${esc(g.issuesWithoutRequirement.join(', '))}</li>` : '',
  ].join('');
  const bar = (n: number, cls: string) => (n ? `<span class="${cls}" style="flex:${n}"></span>` : '');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Test report: ${esc(run.name)}</title>
<style>${DOC_CSS}</style></head><body><main>
<h1>Test report: ${esc(run.name)}</h1>
<table class="meta">${header(run, index)
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td${/commit/i.test(k) ? ' class="mono"' : ''}>${esc(v)}</td></tr>`)
    .join('')}<tr><td>Report generated</td><td>${esc(generated.toLocaleString())}</td></tr></table>
<h2>Summary</h2>
<div class="tiles">
<div class="tile"><span class="muted">Passed</span><b style="color:var(--ok)">${s.passed}</b></div>
<div class="tile"><span class="muted">Failed</span><b style="color:var(--bad)">${s.failed}</b></div>
<div class="tile"><span class="muted">Blocked</span><b>${s.blocked}</b></div>
<div class="tile"><span class="muted">Not run</span><b>${s.notRun}</b></div>
</div>
<div class="bar">${bar(s.passed, 'passed')}${bar(s.failed, 'failed')}${bar(s.blocked, 'blocked')}</div>
<p class="muted">${s.total} test cases · ${pct(s.done, s.total)}% executed · ${pct(s.passed, s.total)}% passed</p>
${
  bad.length
    ? `<h2>Failed and blocked</h2><table><tr><th>Test case</th><th>Result</th><th>Tester</th><th>Note</th></tr>${bad
        .map((c) => `<tr><td><span class="mono">${esc(c.id)}</span> ${esc(index.byId.get(c.id)?.title ?? '')}</td><td>${pill(c.result)}</td><td>${esc(c.tester)}<br><span class="muted nowrap">${esc(c.date)}</span></td><td>${noteHtml(c, index)}</td></tr>`)
        .join('')}</table>`
    : ''
}
<h2>By requirement</h2>
<table><tr><th>Requirement</th><th>Result</th><th>Test cases</th></tr>${groups(run, index)
    .map(
      (gr) =>
        `<tr><td>${gr.req ? `<span class="mono">${esc(gr.req.id)}</span> ${esc(gr.req.title)}` : '<span class="muted">No requirement</span>'}</td><td>${pill(verdict(gr))}</td><td>${gr.cases
          .map(({ c }) => `<span class="mono">${esc(c.id)}</span> ${pill(c.result)}`)
          .join('<br>')}</td></tr>`,
    )
    .join('')}</table>
<h2>Test cases</h2>
<table><tr><th>Test case</th><th>Result</th><th>Tester</th><th>Note</th><th>Why in this run</th></tr>${run.cases
    .map(
      (c) =>
        `<tr><td><span class="mono">${esc(c.id)}</span> ${esc(index.byId.get(c.id)?.title ?? '(deleted)')}${c.assignee ? `<br><span class="muted">for ${esc(c.assignee)}</span>` : ''}</td><td>${pill(c.result)}</td><td>${esc(c.tester)}<br><span class="muted nowrap">${esc(c.date)}</span></td><td>${noteHtml(c, index)}</td><td class="muted">${esc(c.reason.join('; '))}</td></tr>`,
    )
    .join('')}</table>
${gaps ? `<h2>Not covered by this run</h2><ul>${gaps}</ul>` : ''}
</main></body></html>
`;
}
