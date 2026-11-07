// The commands, the same in the web server and the desktop app (`Tracey.AppImage check`):
//
//   check [DIR]                                      validate a repository (for CI)
//   import-reqif EXPORT.reqifz… --init-map MAP.yml    write a map to edit
//   import-reqif EXPORT.reqifz… --map MAP.yml --dry-run
//   import-reqif EXPORT.reqifz… --map MAP.yml [--into DIR] [--force]
//
// The DOORS import (ReqIF) takes one export or several (modules exported separately, read
// as one so the links between them come across). Without --map, it guesses one. It never
// overwrites a file, and stops if an imported ID is already in the repository (--force
// imports anyway; check then reports duplicates).
import { existsSync, promises as fs } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { readExport } from './reqifz';
import { readProjectFiles } from './service';
import { buildIndex, coverage, forVariant } from '../core/model';
import { formatReport, guessMap, mapToYaml, planImport, readMap } from '../core/doors';

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
    if (args[0] === 'import-reqif') return await importReqif(args, self);
    if (args[0] === 'check') return await check(args[1] ?? '.');
    return null;
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
}

export async function check(dirArg: string): Promise<number> {
  const dir = resolve(dirArg);
  const { config, files } = await readProjectFiles(dir);
  const index = buildIndex(files, config);
  const cov = coverage(index);
  for (const p of index.problems) console.log(`${p.severity === 'error' ? 'error' : 'warning'}: ${p.path ?? ''}: ${p.message}`);
  const errors = index.problems.filter((p) => p.severity === 'error').length;
  console.log(
    `\n${cov.requirements.length} requirements, ${cov.testcases.length} test cases; ${cov.untested.length} requirements without test cases; ` +
      `${cov.suspect.length} suspect links; ${errors} errors, ${index.problems.length - errors} warnings.`,
  );
  // Per variant: a requirement counts only when a test case for that variant verifies it.
  for (const v of index.config.variants) {
    const c = coverage(forVariant(index, v.key));
    const live = c.requirements.filter((r) => r.status !== 'obsolete').length;
    console.log(
      `  ${v.name}: ${c.tested.length} of ${live} requirements verified${live ? ` (${Math.round((c.tested.length / live) * 100)}%)` : ''}` +
        (c.untested.length ? `; without test cases: ${c.untested.map((r) => r.id).join(', ')}` : ''),
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
  if (!exports.length) {
    console.error(`Usage: ${self} import-reqif EXPORT.reqif[z]… [--init-map MAP.yml | --map MAP.yml] [--into DIR] [--dry-run] [--force]`);
    return 2;
  }
  const into = resolve(opt('into') ?? '.');
  const exp = await readExport(exports.map((f) => resolve(f)));
  if (exports.length > 1) console.log(`Read ${exports.length} exports together: ${exp.reqif.specs.length} modules.`);
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
  const clashes = [...new Set(plan.report.duplicates)].filter((id) => existingIds.has(id));
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
