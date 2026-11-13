// The commands, the same in the web server and the desktop app (`Tracey.AppImage check`):
//
//   check [DIR]                                      validate a repository (for CI)
//   import-reqif EXPORT.reqifz… --init-map MAP.yml    write a map to edit
//   import-reqif EXPORT.reqifz… --map MAP.yml --dry-run
//   import-reqif EXPORT.reqifz… --map MAP.yml [--into DIR] [--force]
//   import-html MODULE.htm…  (the same options: DOORS modules exported as HTML)
//   export-needs [DIR] [--out needs.json] [--version 1.0] [--project NAME]
//   import-needs NEEDS.json [--into DIR] [--version V] [--type spec=requirement]… [--link links=refines]…
//                [--keep-fields a,b] [--dry-run]
//
// The DOORS import (ReqIF) takes one export or several (modules exported separately, read
// as one so the links between them come across). Without --map, it guesses one. It never
// overwrites a file, and stops if an imported ID is already in the repository (--force
// imports anyway; check then reports duplicates). import-html reads modules exported as
// HTML instead (when ReqIF isn't available), and then works the same.
import { existsSync, promises as fs } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { readExport, readHtmlExport } from './reqifz';
import { readProjectFiles } from './service';
import { buildIndex, coverage, forVariant } from '../core/model';
import { formatReport, guessMap, mapToYaml, planImport, readMap } from '../core/doors';
import { formatNeedsReport, needsJson, planNeedsImport } from '../core/needs';
import { basename } from 'node:path';

async function allFiles(root: string, dir = root, out = new Set<string>()): Promise<Set<string>> {
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) await allFiles(root, full, out);
    else out.add(relative(root, full).split(sep).join('/'));
  }
  return out;
}

// Runs a command, or gives null when the arguments aren't one. `self` is how to run this
// program, for the hints it prints.
export async function runCommand(args: string[], self: string): Promise<number | null> {
  try {
    if (args[0] === 'import-reqif' || args[0] === 'import-html') return await importReqif(args, self);
    if (args[0] === 'check') return await check(args[1] ?? '.');
    if (args[0] === 'export-needs') return await exportNeeds(args);
    if (args[0] === 'import-needs') return await importNeeds(args, self);
    return null;
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
}

export async function check(dirArg: string): Promise<number> {
  const dir = resolve(dirArg);
  const { config, files, truncated } = await readProjectFiles(dir);
  if (truncated) console.log(`warning: more than ${truncated} Markdown files; only the first ${truncated} were read.`);
  const index = buildIndex(files, config);
  const cov = coverage(index);
  for (const p of index.problems) console.log(`${p.severity === 'error' ? 'error' : 'warning'}: ${p.path ?? ''}: ${p.message}`);
  const errors = index.problems.filter((p) => p.severity === 'error').length;
  console.log(
    `\n${cov.requirements.length} requirements, ${cov.testcases.length} test cases; ${cov.untested.length} requirements not covered; ` +
      `${cov.suspect.length + cov.suspectRefines.length + cov.suspectLinks.length} suspect links; ${errors} errors, ${index.problems.length - errors} warnings.`,
  );
  for (const r of cov.rules) {
    const t = index.config.types.find((x) => x.key === r.rule.type);
    console.log(
      `  Rule: every ${t?.name.toLowerCase() ?? r.rule.type} needs ${r.rule.link}: ${r.items.length - r.missing.length} of ${r.items.length} do` +
        (r.missing.length ? `; ${r.rule.tag.toLowerCase()}: ${r.missing.map((i) => i.id).join(', ')}` : ''),
    );
  }
  // Per variant: a requirement counts only when a test case for that variant verifies it.
  for (const v of index.config.variants) {
    const c = coverage(forVariant(index, v.key));
    const live = c.counted.length;
    console.log(
      `  ${v.name}: ${c.tested.length} of ${live} requirements covered${live ? ` (${Math.round((c.tested.length / live) * 100)}%)` : ''}` +
        (c.untested.length ? `; not covered: ${c.untested.map((r) => r.id).join(', ')}` : ''),
    );
  }
  return errors ? 1 : 0;
}

export async function importReqif(args: string[], self = 'node out/server/index.js'): Promise<number> {
  const opt = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const withValue = new Set(['--map', '--init-map', '--into']);
  const rest = args.slice(1);
  const exports = rest.filter((a, i) => !a.startsWith('--') && !withValue.has(rest[i - 1]));
  const html = args[0] === 'import-html';
  if (!exports.length) {
    console.error(`Usage: ${self} ${html ? 'import-html MODULE.htm' : 'import-reqif EXPORT.reqif[z]'}… [--init-map MAP.yml | --map MAP.yml] [--into DIR] [--dry-run] [--force]`);
    return 2;
  }
  const into = resolve(opt('into') ?? '.');
  const exp = html ? await readHtmlExport(exports.map((f) => resolve(f))) : { ...(await readExport(exports.map((f) => resolve(f)))), notes: [] as string[] };
  if (exports.length > 1) console.log(`Read ${exports.length} exports together: ${exp.reqif.specs.length} modules.`);
  // What the HTML held: which column is which, and links found. Worth a look before importing.
  if (exp.notes.length) console.log(`${exp.notes.join('\n')}\n`);
  const { config, files } = existsSync(into) ? await readProjectFiles(into) : { config: null, files: [] };
  const index = buildIndex(files, config);
  const guess = guessMap(exp.reqif, index.config);
  const mapFile = opt('map');
  const map = mapFile ? readMap(await fs.readFile(resolve(mapFile), 'utf8'), guess) : guess;

  const initMap = opt('init-map');
  if (initMap) {
    if (existsSync(initMap)) {
      console.error(`${initMap} already exists; not overwriting it.`);
      return 1;
    }
    await fs.writeFile(initMap, mapToYaml(map, exp.reqif));
    console.log(`Wrote ${initMap}: ${exp.reqif.specs.length} modules, ${exp.reqif.objects.size} objects, ${exp.reqif.relations.length} links. Edit it, then run with --map ${initMap}${exports.length > 1 ? ', giving the same exports' : ''}.`);
    return 0;
  }

  const existingIds = new Set(index.items.map((i) => i.id));
  const plan = planImport(exp.reqif, map, index.config, {
    attachment: exp.attachment,
    existingIds,
    existingPaths: await allFiles(into),
    date: new Date().toISOString().slice(0, 10),
  });
  console.log(formatReport(plan.report));
  const clashes = [...new Set(plan.report.existing)];
  console.log(`\n${plan.files.size} files to write into ${into}.`);
  if (args.includes('--dry-run')) {
    console.log('Dry run: nothing written.');
    return 0;
  }
  if (clashes.length && !args.includes('--force')) {
    console.error(`\nThese IDs are already in the repository: ${clashes.slice(0, 20).join(', ')}${clashes.length > 20 ? '…' : ''}. Nothing written (use --force to import anyway).`);
    return 1;
  }
  for (const [path, data] of plan.files) {
    const full = join(into, path);
    await fs.mkdir(dirname(full), { recursive: true });
    await fs.writeFile(full, data, { flag: 'wx' });
  }
  if (!config) {
    await fs.writeFile(join(into, 'trace.yml'), `# Made by the DOORS import. See README for every option.\n${plan.traceYml}`, { flag: 'wx' });
    console.log('Wrote trace.yml.');
  } else console.log(`\nSettings matching the import (merge into trace.yml):\n${plan.traceYml}`);
  const shown = relative(process.cwd(), into);
  console.log(`Done. Check it with: ${self} check ${!shown ? '.' : shown.startsWith('..') ? into : shown}`);
  return 0;
}

// Options: --name value, repeatable ones (--type a=b) collected; the rest are positional.
function options(args: string[], withValue: string[]) {
  const rest: string[] = [];
  const values = new Map<string, string[]>();
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    const name = a.startsWith('--') ? a.slice(2) : null;
    if (name && withValue.includes(name)) values.set(name, [...(values.get(name) ?? []), args[++i] ?? '']);
    else if (!name) rest.push(a);
  }
  const pairs = (name: string) =>
    Object.fromEntries(
      (values.get(name) ?? []).map((v) => {
        const [k, ...to] = v.split('=');
        return [k.trim(), to.join('=').trim()];
      }),
    );
  return { rest, one: (name: string) => values.get(name)?.at(-1), pairs, flag: (name: string) => args.includes(`--${name}`) };
}

export async function exportNeeds(args: string[]): Promise<number> {
  const o = options(args, ['out', 'version', 'project']);
  const dir = resolve(o.rest[0] ?? '.');
  const { config, files } = await readProjectFiles(dir);
  const index = buildIndex(files, config);
  const text = needsJson(index, { project: o.one('project') ?? basename(dir), version: o.one('version') });
  const out = o.one('out') ?? 'needs.json';
  if (out === '-') process.stdout.write(text);
  else {
    await fs.writeFile(resolve(out), text);
    console.log(`Wrote ${out}: ${index.items.length} needs.`);
  }
  return 0;
}

export async function importNeeds(args: string[], self = 'node out/server/index.js'): Promise<number> {
  const o = options(args, ['into', 'version', 'type', 'link', 'keep-fields']);
  if (!o.rest.length) {
    console.error(`Usage: ${self} import-needs NEEDS.json [--into DIR] [--version V] [--type NEEDTYPE=TYPE]… [--link FIELD=LINK]… [--keep-fields a,b] [--dry-run]`);
    return 2;
  }
  const into = resolve(o.one('into') ?? '.');
  const { config, files } = existsSync(into) ? await readProjectFiles(into) : { config: null, files: [] };
  const index = buildIndex(files, config);
  const plan = planNeedsImport(await fs.readFile(resolve(o.rest[0]), 'utf8'), index, {
    version: o.one('version'),
    types: o.pairs('type'),
    links: o.pairs('link'),
    keepFields: (o.one('keep-fields') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    existingPaths: await allFiles(into),
  });
  console.log(formatNeedsReport(plan.report, index.config));
  console.log(`\n${plan.files.size} files to write into ${into}.`);
  if (o.flag('dry-run')) {
    console.log('Dry run: nothing written.');
    return 0;
  }
  for (const [path, data] of plan.files) {
    const full = join(into, path);
    await fs.mkdir(dirname(full), { recursive: true });
    await fs.writeFile(full, data, { flag: 'wx' });
  }
  const shown = relative(process.cwd(), into);
  console.log(`Done. Check it with: ${self} check ${!shown ? '.' : shown.startsWith('..') ? into : shown}`);
  return 0;
}
