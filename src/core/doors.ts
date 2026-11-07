// Importing a DOORS (9 or Next) ReqIF export into Tracey's files.
//
// Each module (ReqIF specification) becomes a folder of Markdown files, one per
// requirement or test case, plus a README.md keeping the module's headings,
// information objects and order, with links to the items. A map says which module
// goes where and which attributes and link types mean what; guessMap() proposes one.
import { parse, parseDocument, isSeq, isMap, type Document, type Pair } from 'yaml';
import { fingerprint, slug } from './model';
import type { Kind, TraceConfig } from './config';
import { walkSpec, type Reqif, type ReqifObject, type ReqifValue } from './reqif';
import { xhtmlToMarkdown } from './xhtml';

export interface ModuleMap {
  kind: Kind | 'skip';
  dir: string;
  prefix: string;
}

export interface DoorsMap {
  modules: Record<string, ModuleMap>; // by module name
  attributes: {
    id: string[]; // the first that has a value: a number gets the prefix
    title: string[];
    text: string[];
    status: string | null;
    variants: string | null;
    components: string | null;
    keep: string[]; // copied into the front matter as they are
  };
  types: { heading: string[]; note: string[] }; // object types that are headings, or information
  values: {
    status: Record<string, string>; // DOORS value → Tracey status, for requirements
    testStatus: Record<string, string>; // …and for test cases
    variants: Record<string, string>;
    components: Record<string, string>;
  };
  links: { verifies: string[]; refines: string[]; reversed: string[] }; // link (relation) type names
}

export interface ImportReport {
  title: string;
  modules: { name: string; kind: ModuleMap['kind']; dir: string; prefix: string; items: number; headings: number; notes: number; empty: number }[];
  links: { verifies: number; refines: number; dangling: number; ignored: Record<string, number>; odd: string[] };
  images: { copied: number; missing: string[]; notShown: string[] };
  statuses: { value: string; kind: Kind; status: string; count: number; known: boolean }[];
  unknownVariants: string[];
  unknownComponents: string[];
  duplicates: string[];
  generatedIds: string[];
  unmappedAttributes: string[];
}

export interface ImportPlan {
  files: Map<string, string | Uint8Array>;
  report: ImportReport;
  traceYml: string; // settings matching what was imported, to merge into trace.yml
}

// DOORS's own bookkeeping attributes: not worth copying into the files.
const SYSTEM_ATTR =
  /^(ReqIF\..*|Created (By|On|Thru)|Last Modified (By|On)|Object (Number|Level|Identifier|Short Text|Heading|Text)|Absolute Number|Paragraph Style|Picture|TableType|TableCell.*|IsTableHeader|OLE|Linked to|URL|DXL|Identifier|Primary Text|Title|Artifact Type|Format|Modified (By|On)|Created|Modified)$/i;

const STOP = new Set(['and', 'of', 'the', 'for', 'to', 'a', 'an', 'in', 'on', 'och', 'av', 'för']);

function initials(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter((w) => w && !STOP.has(w.toLowerCase()));
  const i = words.map((w) => w[0].toUpperCase()).join('').slice(0, 4);
  return (i.length >= 2 ? i : name.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase() || 'DOC') + '-';
}

const objectsIn = (reqif: Reqif, specIndex: number) => walkSpec(reqif.specs[specIndex]).map((w) => reqif.objects.get(w.object)).filter((o): o is ReqifObject => !!o);

function guessStatus(value: string, statuses: string[], kind: Kind): string {
  const v = value.toLowerCase().trim();
  const exact = statuses.find((s) => s.toLowerCase() === v);
  if (exact) return exact;
  const pick = (...names: string[]) => names.find((n) => statuses.includes(n));
  const guess =
    /accept|approv|releas|baselin|agreed|valid/.test(v)
      ? pick(kind === 'testcase' ? 'ready' : 'approved', 'approved', 'ready')
      : /reject|obsolete|delet|retire|deprecat|cancel|withdrawn/.test(v)
        ? pick('obsolete')
        : /review|submit|check/.test(v)
          ? pick('review', 'draft')
          : /draft|propos|new|open|work|progress|initial/.test(v)
            ? pick('draft')
            : undefined;
  return guess ?? slug(value);
}

// A map to start from: modules by name (test-like names hold test cases), the usual
// DOORS 9 and DOORS Next attribute names, and link types by name.
export function guessMap(reqif: Reqif, config: TraceConfig): DoorsMap {
  const attrs = new Map<string, Set<string>>(); // name → kinds
  const enumValues = new Map<string, Set<string>>();
  const typeNames = new Set<string>();
  for (const o of reqif.objects.values()) {
    typeNames.add(o.type);
    for (const [name, v] of o.values) {
      if (!attrs.has(name)) attrs.set(name, new Set());
      attrs.get(name)!.add(v.kind);
      if (v.enums) for (const e of v.enums) (enumValues.get(name) ?? enumValues.set(name, new Set()).get(name)!).add(e);
    }
  }
  const present = (names: string[]) => names.filter((n) => attrs.has(n));
  const firstMatch = (re: RegExp) => [...attrs.keys()].find((n) => re.test(n) && !/^ReqIF\./.test(n)) ?? null;

  const isTest = (i: number) => /test|verif|validat|qualif/i.test(reqif.specs[i].name) || objectsIn(reqif, i).some((o) => /test/i.test(o.type));
  const kinds = reqif.specs.map((_, i) => (isTest(i) ? 'testcase' : 'requirement') as Kind);
  const count = (k: Kind) => kinds.filter((x) => x === k).length;
  const used = new Set<string>();
  const modules: Record<string, ModuleMap> = {};
  reqif.specs.forEach((s, i) => {
    const k = kinds[i];
    const kc = k === 'requirement' ? config.requirements : config.testcases;
    let prefix = count(k) === 1 ? kc.prefix : initials(s.name);
    for (let n = 2; used.has(prefix); n++) prefix = prefix.replace(/\d*-$/, `${n}-`);
    used.add(prefix);
    const dir = count(k) === 1 ? kc.dir : `${kc.dir}/${slug(s.name) || 'module'}`;
    modules[s.name] = { kind: k, dir, prefix };
  });

  const status = firstMatch(/status|state|lifecycle/i);
  const variants = firstMatch(/variant|product line|applicab/i);
  const components = firstMatch(/component|subsystem|feature area/i);
  const id = present(['ReqIF.ForeignID', 'Absolute Number', 'Identifier', 'ID', 'Id']);
  const title = present(['ReqIF.ChapterName', 'Object Heading', 'ReqIF.Name', 'Title', 'Name']);
  const text = present(['ReqIF.Text', 'Object Text', 'Primary Text', 'Text', 'Description', 'ReqIF.Description']);
  const mapped = new Set([...id, ...title, ...text, status, variants, components].filter(Boolean) as string[]);
  const keep = [...attrs].filter(([n, k]) => !mapped.has(n) && !SYSTEM_ATTR.test(n) && !k.has('xhtml')).map(([n]) => n);

  const statusValues = status ? [...(enumValues.get(status) ?? [])] : [];
  const relTypes = [...new Set(reqif.relations.map((r) => r.type))];
  return {
    modules,
    attributes: { id, title, text, status, variants, components, keep },
    types: {
      heading: [...typeNames].filter((t) => /heading|chapter|section/i.test(t)),
      note: [...typeNames].filter((t) => /information|^info|note|comment|rationale|description/i.test(t)),
    },
    values: {
      status: Object.fromEntries(statusValues.map((v) => [v, guessStatus(v, config.statuses, 'requirement')])),
      testStatus: Object.fromEntries(statusValues.map((v) => [v, guessStatus(v, config.testcaseStatuses, 'testcase')])),
      variants: Object.fromEntries([...(variants ? (enumValues.get(variants) ?? []) : [])].map((v) => [v, config.variants.find((x) => x.name.toLowerCase() === v.toLowerCase())?.key ?? slug(v)])),
      components: Object.fromEntries(
        [...(components ? (enumValues.get(components) ?? []) : [])].map((v) => [v, config.components.find((x) => x.name.toLowerCase() === v.toLowerCase())?.key ?? slug(v)]),
      ),
    },
    links: {
      verifies: relTypes.filter((t) => /verif|test|validat/i.test(t)),
      refines: relTypes.filter((t) => !/verif|test|validat/i.test(t)),
      reversed: [],
    },
  };
}

// ---- the map as a file -------------------------------------------------------------

export function mapToYaml(map: DoorsMap, reqif: Reqif): string {
  const doc = parseDocument('{}');
  doc.contents = doc.createNode(map) as never;
  // Short lists on one line.
  const flowAll = (node: unknown) => {
    if (isSeq(node)) node.flow = true;
    else if (isMap(node)) for (const p of node.items as Pair[]) flowAll(p.value);
  };
  flowAll(doc.contents);
  const mods = doc.get('modules', true);
  if (isMap(mods)) for (const p of mods.items as Pair[]) if (isMap(p.value)) (p.value as { flow?: boolean }).flow = true;

  const counts = new Map<string, number>();
  for (const r of reqif.relations) counts.set(r.type, (counts.get(r.type) ?? 0) + 1);
  const attrs = new Map<string, string>();
  for (const o of reqif.objects.values()) for (const [n, v] of o.values) if (!attrs.has(n)) attrs.set(n, v.kind);
  const types = new Map<string, number>();
  for (const o of reqif.objects.values()) types.set(o.type, (types.get(o.type) ?? 0) + 1);
  const objectCounts = reqif.specs.map((s, i) => `#   ${s.name}: ${objectsIn(reqif, i).length} objects`);

  return `# How to import "${reqif.title || 'the DOORS export'}" into Tracey. Edit it, then run the import with --map.
#
# modules: each DOORS module (ReqIF specification): kind (requirement, testcase or skip),
#   the folder its files go in, and the ID prefix (an object's number is added to it).
# attributes: which attributes hold the ID, title, text, status, variants and components
#   (the first with a value wins); keep: others copied into the front matter as they are.
# types: object types that are headings, or information (kept in the module's README).
# values: DOORS values → Tracey statuses (status for requirements, testStatus for test
#   cases), variant keys and component keys.
# links: link types meaning "test case verifies requirement" (either direction), and
#   "refines" between requirements (source refines target; list a type under reversed
#   if its links point the other way).
${doc.toString({ lineWidth: 0, flowCollectionPadding: false })}
# Found in the export:
${objectCounts.join('\n')}
#   object types: ${[...types].map(([t, n]) => `${t || '(none)'} (${n})`).join(', ') || 'none'}
#   attributes: ${[...attrs].map(([n, k]) => `${n} (${k})`).join(', ') || 'none'}
#   link types: ${[...counts].map(([t, n]) => `${t || '(none)'} (${n})`).join(', ') || 'none'}
`;
}

export function readMap(text: string, fallback: DoorsMap): DoorsMap {
  const o = (parse(text) ?? {}) as Partial<DoorsMap>;
  const list = (v: unknown, d: string[]) => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : d);
  const str = (v: unknown, d: string | null) => (v === null ? null : typeof v === 'string' && v ? v : d);
  const rec = (v: unknown, d: Record<string, string>) => (v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, String(x)])) : d);
  const a = (o.attributes ?? {}) as Partial<DoorsMap['attributes']>;
  const modules: Record<string, ModuleMap> = {};
  // Modules the map doesn't name keep the guess.
  for (const [name, m] of Object.entries({ ...fallback.modules, ...(o.modules ?? {}) })) {
    const f = fallback.modules[name];
    const kind = (['requirement', 'testcase', 'skip'].includes(String(m?.kind)) ? m.kind : (f?.kind ?? 'requirement')) as ModuleMap['kind'];
    modules[name] = { kind, dir: String(m?.dir ?? f?.dir ?? 'requirements').replace(/^\.?\/+|\/+$/g, ''), prefix: String(m?.prefix ?? f?.prefix ?? 'REQ-') };
  }
  return {
    modules,
    attributes: {
      id: list(a.id, fallback.attributes.id),
      title: list(a.title, fallback.attributes.title),
      text: list(a.text, fallback.attributes.text),
      status: a.status === undefined ? fallback.attributes.status : str(a.status, null),
      variants: a.variants === undefined ? fallback.attributes.variants : str(a.variants, null),
      components: a.components === undefined ? fallback.attributes.components : str(a.components, null),
      keep: list(a.keep, fallback.attributes.keep),
    },
    types: { heading: list(o.types?.heading, fallback.types.heading), note: list(o.types?.note, fallback.types.note) },
    values: {
      status: rec(o.values?.status, fallback.values.status),
      testStatus: rec(o.values?.testStatus, fallback.values.testStatus),
      variants: rec(o.values?.variants, fallback.values.variants),
      components: rec(o.values?.components, fallback.values.components),
    },
    links: { verifies: list(o.links?.verifies, fallback.links.verifies), refines: list(o.links?.refines, fallback.links.refines), reversed: list(o.links?.reversed, []) },
  };
}

// ---- the import ----------------------------------------------------------------------

interface Planned {
  object: ReqifObject;
  module: string;
  kind: Kind;
  dir: string;
  id: string;
  doorsId: string;
  title: string;
  body: string;
  section: string | null;
  status: string;
  variants: string[];
  components: string[];
  keep: Record<string, unknown>;
  verifies: string[];
  refines: string[];
  path: string;
}

const firstValue = (o: ReqifObject, names: string[]): ReqifValue | undefined => names.map((n) => o.values.get(n)).find((v) => v && v.text.trim());

function plainValue(v: ReqifValue): unknown {
  if (v.kind === 'enum') return v.enums!.length === 1 ? v.enums![0] : v.enums;
  if (v.kind === 'integer') return Number.isSafeInteger(Number(v.text)) ? Number(v.text) : v.text;
  if (v.kind === 'real') return Number.isFinite(Number(v.text)) ? Number(v.text) : v.text;
  if (v.kind === 'boolean') return v.text === 'true';
  if (v.kind === 'date') return v.text.replace(/T00:00:00(\.0+)?(Z|[+-]00:00)?$/, '');
  return v.text;
}

// A title from the text, when DOORS has none: its first sentence, at most ~80 characters.
function titleFrom(text: string): string {
  // The first paragraph that isn't a table or a picture.
  const para = text.split(/\n\s*\n/).find((p) => !/^\s*(\||!\[|\*\(embedded)/.test(p)) ?? '';
  const plain = para
    .replace(/\*\(embedded object not imported:[^)]*\)\*/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~`#>|\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const sentence = (/^(.{10,}?[.!?])(\s|$)/.exec(plain)?.[1] ?? plain).replace(/[\s:;,]+$/, '');
  if (sentence.length <= 80) return sentence.replace(/[.]$/, '');
  return sentence.slice(0, 78).replace(/\s+\S*$/, '') + '…';
}

const yamlValue = (doc: Document, v: unknown) => {
  const n = doc.createNode(v);
  if (isSeq(n)) n.flow = true;
  return n;
};

export function planImport(
  reqif: Reqif,
  map: DoorsMap,
  config: TraceConfig,
  opts: { attachment: (path: string) => Uint8Array | null; existingIds?: Set<string>; existingPaths?: Set<string>; date?: string },
): ImportPlan {
  const files = new Map<string, string | Uint8Array>();
  const report: ImportReport = {
    title: reqif.title,
    modules: [],
    links: { verifies: 0, refines: 0, dangling: 0, ignored: {}, odd: [] },
    images: { copied: 0, missing: [], notShown: [] },
    statuses: [],
    unknownVariants: [],
    unknownComponents: [],
    duplicates: [],
    generatedIds: [],
    unmappedAttributes: [],
  };
  const taken = new Set([...(opts.existingPaths ?? [])]);
  const unique = (p: string) => {
    let out = p;
    for (let n = 2; taken.has(out) || files.has(out); n++) out = p.replace(/(\.[^./]+)$/, `-${n}$1`);
    taken.add(out);
    return out;
  };
  const byObject = new Map<string, Planned>();
  const items: Planned[] = [];
  const usedAttrs = new Set([...map.attributes.id, ...map.attributes.title, ...map.attributes.text, ...map.attributes.keep, map.attributes.status, map.attributes.variants, map.attributes.components]);
  const allAttrs = new Set<string>();
  const statusCount = new Map<string, { value: string; kind: Kind; status: string; count: number }>();
  const ids = new Set(opts.existingIds ?? []);
  const variantKeys = new Set(config.variants.map((v) => v.key));
  const componentKeys = new Set(config.components.map((c) => c.key));

  // Pictures go beside the item, named after it.
  const imageContext = (base: string, dir: string, stem: string) => {
    let n = 0;
    return {
      image(data: string, type: string) {
        const path = [...(base ? base.split('/') : []), ...data.split('/')].reduce<string[]>((acc, p) => (p === '..' ? acc.slice(0, -1) : p && p !== '.' ? [...acc, p] : acc), []).join('/');
        const bytes = opts.attachment(path) ?? opts.attachment(decodeURIComponent(path));
        if (!bytes) {
          report.images.missing.push(`${stem}: ${data}`);
          return null;
        }
        const ext = (/\.([A-Za-z0-9]+)$/.exec(data)?.[1] ?? type.split('/')[1] ?? 'png').toLowerCase().replace('jpeg', 'jpg');
        const name = `${stem}${++n === 1 ? '' : `-${n}`}.${ext}`;
        files.set(unique(`${dir ? dir + '/' : ''}images/${name}`), bytes);
        report.images.copied++;
        return `images/${name}`;
      },
      skipped: (what: string) => report.images.notShown.push(`${stem}: ${what}`),
    };
  };

  const markdownOf = (v: ReqifValue | undefined, base: string, dir: string, stem: string) => {
    if (!v) return '';
    if (v.kind === 'xhtml' && v.xhtml) return xhtmlToMarkdown(v.xhtml, imageContext(base, dir, stem));
    return v.text
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean)
      .join('\n\n');
  };

  reqif.specs.forEach((spec) => {
    const m = map.modules[spec.name] ?? { kind: 'skip', dir: '', prefix: '' };
    const row = { name: spec.name, kind: m.kind, dir: m.dir, prefix: m.prefix, items: 0, headings: 0, notes: 0, empty: 0 };
    report.modules.push(row);
    if (m.kind === 'skip') return;
    const kind = m.kind;
    const outline: string[] = []; // blocks; consecutive items share one list block
    const headingAt: string[] = []; // the heading in force at each depth
    const counters: number[] = [];
    let listOpen = false;
    const walk = walkSpec(spec);
    for (const w of walk) {
      const o = reqif.objects.get(w.object);
      if (!o) continue;
      for (const n of o.values.keys()) allAttrs.add(n);
      headingAt.length = w.depth - 1;
      const textValue = firstValue(o, map.attributes.text);
      const titleValue = firstValue(o, map.attributes.title);
      const isHeading = map.types.heading.includes(o.type) || (!!titleValue && !textValue && !map.types.note.includes(o.type));
      if (isHeading) {
        counters.length = w.depth;
        counters[w.depth - 1] = (counters[w.depth - 1] ?? 0) + 1;
        const number = Array.from({ length: w.depth }, (_, i) => counters[i] ?? 1).join('.');
        const label = `${number} ${titleValue!.text.trim()}`;
        headingAt[w.depth - 1] = label;
        outline.push(`${'#'.repeat(Math.min(w.depth + 1, 6))} ${label}`);
        listOpen = false;
        row.headings++;
        continue;
      }
      if (map.types.note.includes(o.type)) {
        const md = markdownOf(textValue ?? titleValue, spec.base, m.dir, `${slug(spec.name)}-note-${row.notes + 1}`);
        if (md) {
          outline.push(md);
          listOpen = false;
          row.notes++;
        }
        continue;
      }
      if (!textValue && !titleValue) {
        row.empty++;
        continue;
      }
      // An item.
      const raw = firstValue(o, map.attributes.id)?.text.trim() ?? '';
      let id = /^\d+$/.test(raw) ? `${m.prefix}${raw}` : /^[A-Za-z0-9][\w.-]*$/.test(raw) ? raw : '';
      if (!id) {
        let n = 1;
        while (ids.has(`${m.prefix}X${n}`)) n++;
        id = `${m.prefix}X${n}`;
        report.generatedIds.push(`${id} (${spec.name}, no ID attribute)`);
      }
      if (ids.has(id)) report.duplicates.push(id);
      ids.add(id);
      const body = markdownOf(textValue, spec.base, m.dir, id);
      const title = titleValue?.text.trim() || titleFrom(body) || id;
      const statusRaw = map.attributes.status ? o.values.get(map.attributes.status)?.text.trim() : '';
      const statusMap = kind === 'testcase' ? map.values.testStatus : map.values.status;
      const status = statusRaw ? (statusMap[statusRaw] ?? guessStatus(statusRaw, kind === 'testcase' ? config.testcaseStatuses : config.statuses, kind)) : '';
      if (statusRaw) {
        const key = `${kind}\n${statusRaw}`;
        const e = statusCount.get(key) ?? { value: statusRaw, kind, status, count: 0 };
        e.count++;
        statusCount.set(key, e);
      }
      const listOf = (attr: string | null, values: Record<string, string>, known: Set<string>, unknown: string[]) => {
        const v = attr ? o.values.get(attr) : undefined;
        const names = v ? (v.enums ?? v.text.split(/[,;]\s*/)).map((s) => s.trim()).filter(Boolean) : [];
        return names.map((nm) => {
          const key = values[nm] ?? slug(nm);
          if (known.size && !known.has(key) && !unknown.includes(key)) unknown.push(key);
          return key;
        });
      };
      const keep: Record<string, unknown> = {};
      for (const a of map.attributes.keep) {
        const v = o.values.get(a);
        if (v && v.text.trim()) keep[slug(a) || a] = plainValue(v);
      }
      const p: Planned = {
        object: o,
        module: spec.name,
        kind,
        dir: m.dir,
        id,
        doorsId: raw,
        title,
        body,
        section: headingAt.filter(Boolean).pop() ?? null,
        status,
        variants: listOf(map.attributes.variants, map.values.variants, variantKeys, report.unknownVariants),
        components: listOf(map.attributes.components, map.values.components, componentKeys, report.unknownComponents),
        keep,
        verifies: [],
        refines: [],
        path: unique(`${m.dir ? m.dir + '/' : ''}${id}${slug(title) ? '-' + slug(title) : ''}.md`),
      };
      items.push(p);
      byObject.set(o.id, p);
      row.items++;
      const entry = `- [${id}](${p.path.slice(m.dir ? m.dir.length + 1 : 0).replace(/[ ()]/g, (c) => encodeURIComponent(c))}) ${title.replace(/([[\]])/g, '\\$1')}`;
      if (listOpen) outline[outline.length - 1] += `\n${entry}`;
      else outline.push(entry);
      listOpen = true;
    }
    const readme = `# ${spec.name}\n\nImported from DOORS${reqif.title ? ` (${reqif.title})` : ''}${opts.date ? ` on ${opts.date}` : ''}: the module's headings, information and order. Each ${kind === 'requirement' ? 'requirement' : 'test case'} is its own file.\n\n${outline.join('\n\n')}\n`;
    const sameDir = Object.values(map.modules).filter((x) => x.dir === m.dir && x.kind !== 'skip').length > 1;
    files.set(unique(`${m.dir ? m.dir + '/' : ''}${sameDir ? slug(spec.name) || 'module' : 'README'}.md`), readme);
  });

  // Links.
  for (const r of reqif.relations) {
    const verify = map.links.verifies.includes(r.type);
    const refine = map.links.refines.includes(r.type);
    if (!verify && !refine) {
      report.links.ignored[r.type || '(no type)'] = (report.links.ignored[r.type || '(no type)'] ?? 0) + 1;
      continue;
    }
    const a = byObject.get(r.source);
    const b = byObject.get(r.target);
    if (!a || !b) {
      report.links.dangling++;
      continue;
    }
    if (a.kind !== b.kind) {
      // A test case and a requirement: the test verifies it, whichever way DOORS drew it.
      const [test, req] = a.kind === 'testcase' ? [a, b] : [b, a];
      if (!test.verifies.includes(req.id)) test.verifies.push(req.id);
      report.links.verifies++;
    } else if (a.kind === 'requirement' && refine) {
      const [from, to] = map.links.reversed.includes(r.type) ? [b, a] : [a, b];
      if (!from.refines.includes(to.id)) from.refines.push(to.id);
      report.links.refines++;
    } else report.links.odd.push(`${a.id} → ${b.id} (${r.type}: both are ${a.kind === 'testcase' ? 'test cases' : 'requirements'})`);
  }

  // The files.
  const byId = new Map(items.map((i) => [i.id, i]));
  for (const it of items) {
    const kc = it.kind === 'requirement' ? config.requirements : config.testcases;
    const doc = parseDocument('');
    doc.contents = doc.createNode({}) as never;
    doc.set('id', it.id);
    if (!it.id.startsWith(kc.prefix)) doc.set('type', it.kind);
    doc.set('title', it.title);
    if (it.status) doc.set('status', it.status);
    if (it.variants.length) doc.set('variants', yamlValue(doc, it.variants));
    if (it.components.length) doc.set('components', yamlValue(doc, it.components));
    if (it.kind === 'testcase') doc.set('verifies', yamlValue(doc, it.verifies));
    if (it.refines.length) doc.set('refines', yamlValue(doc, it.refines));
    if (it.section) doc.set('section', it.section);
    for (const [k, v] of Object.entries(it.keep)) if (!doc.has(k)) doc.set(k, yamlValue(doc, v));
    doc.set('doors', yamlValue(doc, { module: it.module, id: it.doorsId || null }));
    const d = doc.get('doors', true);
    if (isMap(d)) (d as { flow?: boolean }).flow = true;
    // The links start reviewed: as DOORS had them when exported.
    if (it.kind === 'testcase' && it.verifies.length) {
      const reviewed: Record<string, string> = {};
      for (const r of it.verifies) {
        const req = byId.get(r);
        if (req) reviewed[r] = fingerprint({ title: req.title, body: req.body });
      }
      doc.set('reviewed', doc.createNode(reviewed));
    }
    const front = doc.toString({ lineWidth: 0, flowCollectionPadding: false });
    files.set(it.path, `---\n${front}---\n${it.body ? it.body + '\n' : ''}`);
  }

  report.statuses = [...statusCount.values()].map((s) => ({ ...s, known: (s.kind === 'testcase' ? config.testcaseStatuses : config.statuses).includes(s.status) }));
  report.unmappedAttributes = [...allAttrs].filter((a) => !usedAttrs.has(a) && !SYSTEM_ATTR.test(a)).sort();

  // trace.yml settings matching the import.
  const used = (k: Kind) => Object.values(map.modules).filter((x) => x.kind === k);
  const common = (dirs: string[]) => {
    if (!dirs.length) return '';
    const parts = dirs.map((d) => d.split('/'));
    const out: string[] = [];
    for (let i = 0; parts.every((p) => p[i] && p[i] === parts[0][i]); i++) out.push(parts[0][i]);
    return out.join('/');
  };
  const statusesFor = (k: Kind, base: string[]) => [...new Set([...base, ...report.statuses.filter((s) => s.kind === k).map((s) => s.status)])];
  const reqMods = used('requirement');
  const testMods = used('testcase');
  const yml = [
    `requirements: { dir: ${common(reqMods.map((x) => x.dir)) || config.requirements.dir}, prefix: ${reqMods[0]?.prefix ?? config.requirements.prefix} }`,
    `testcases: { dir: ${common(testMods.map((x) => x.dir)) || config.testcases.dir}, prefix: ${testMods[0]?.prefix ?? config.testcases.prefix} }`,
    `statuses: [${statusesFor('requirement', config.statuses).join(', ')}]`,
    `testcaseStatuses: [${statusesFor('testcase', config.testcaseStatuses).join(', ')}]`,
  ];
  const newVariants = [...new Set(items.flatMap((i) => i.variants))];
  if (newVariants.length) yml.push('variants:', ...newVariants.map((v) => `  ${v}: { name: ${Object.entries(map.values.variants).find(([, k]) => k === v)?.[0] ?? v} }`));
  return { files, report, traceYml: yml.join('\n') + '\n' };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function formatReport(r: ImportReport): string {
  const lines: string[] = [`Import of ${r.title || 'the DOORS export'}`, ''];
  for (const m of r.modules)
    lines.push(
      m.kind === 'skip'
        ? `  ${m.name}: skipped`
        : `  ${m.name} → ${m.dir}/ (${m.kind === 'requirement' ? 'requirements' : 'test cases'}, ${m.prefix}…): ${plural(m.items, 'item', 'items')}, ${plural(m.headings, 'heading', 'headings')}, ${plural(m.notes, 'information object', 'information objects')}${m.empty ? `, ${plural(m.empty, 'empty object', 'empty objects')} left out` : ''}`,
    );
  lines.push('', `Links: ${r.links.verifies} verifies, ${r.links.refines} refines${r.links.dangling ? `, ${plural(r.links.dangling, 'link', 'links')} to objects outside the import (left out)` : ''}.`);
  for (const [t, n] of Object.entries(r.links.ignored)) lines.push(`  Link type “${t}” not mapped: ${n} links left out.`);
  for (const o of r.links.odd) lines.push(`  Left out: ${o}`);
  lines.push(`Pictures: ${r.images.copied} copied.`);
  for (const m of r.images.missing) lines.push(`  Missing from the export: ${m}`);
  for (const m of r.images.notShown) lines.push(`  Embedded object without a picture: ${m}`);
  if (r.statuses.length) {
    lines.push('Statuses:');
    for (const s of r.statuses) lines.push(`  ${s.value} → ${s.status} (${s.kind === 'requirement' ? plural(s.count, 'requirement', 'requirements') : plural(s.count, 'test case', 'test cases')})${s.known ? '' : ' (not in trace.yml yet)'}`);
  }
  if (r.unknownVariants.length) lines.push(`Variants not in trace.yml yet: ${r.unknownVariants.join(', ')}`);
  if (r.unknownComponents.length) lines.push(`Components not in trace.yml yet: ${r.unknownComponents.join(', ')}`);
  if (r.generatedIds.length) lines.push(`IDs made up (objects without an ID): ${r.generatedIds.join(', ')}`);
  if (r.duplicates.length) lines.push(`Duplicate IDs (fix before committing): ${[...new Set(r.duplicates)].join(', ')}`);
  if (r.unmappedAttributes.length) lines.push(`Attributes not copied (add them under attributes.keep to keep them): ${r.unmappedAttributes.join(', ')}`);
  return lines.join('\n');
}
