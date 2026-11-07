// `import-reqif`: a DOORS export (ReqIF) into a requirements repository.
//
//   node out/server/index.js import-reqif EXPORT.reqifz --init-map doors-map.yml   write a map to edit
//   node out/server/index.js import-reqif EXPORT.reqifz --map doors-map.yml --dry-run
//   node out/server/index.js import-reqif EXPORT.reqifz --map doors-map.yml [--into DIR] [--force]
//
// Without --map, it guesses one. It never overwrites a file, and stops if an imported ID
// is already in the repository (--force imports anyway; check then reports duplicates).
import { existsSync, promises as fs } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { readExport } from '../backend/reqifz';
import { readProjectFiles } from '../backend/service';
import { buildIndex } from '../core/model';
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

export async function importReqif(args: string[]): Promise<number> {
  const opt = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const withValue = new Set(['--map', '--init-map', '--into']);
  const rest = args.slice(1);
  const file = rest.find((a, i) => !a.startsWith('--') && !withValue.has(rest[i - 1]));
  if (!file) {
    console.error('Usage: import-reqif EXPORT.reqif[z] [--init-map MAP.yml | --map MAP.yml] [--into DIR] [--dry-run] [--force]');
    return 2;
  }
  const into = resolve(opt('into') ?? '.');
  const exp = await readExport(resolve(file));
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
    console.log(`Wrote ${initMap}: ${exp.reqif.specs.length} modules, ${exp.reqif.objects.size} objects, ${exp.reqif.relations.length} links. Edit it, then run with --map ${initMap}.`);
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
  console.log(`Done. Check it with: node out/server/index.js check ${!shown ? '.' : shown.startsWith('..') ? into : shown}`);
  return 0;
}
