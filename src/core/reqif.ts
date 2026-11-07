// ReqIF (OMG Requirements Interchange Format), as DOORS 9 and DOORS Next export it:
// spec objects with typed attribute values, relations between them, and
// specifications (modules) that order the objects in a hierarchy.
import { child, elements, find, parseXml, textOf, type XmlElement, type XmlNode } from './xml';

export type ValueKind = 'string' | 'xhtml' | 'enum' | 'integer' | 'real' | 'date' | 'boolean';

export interface ReqifValue {
  kind: ValueKind;
  text: string; // as plain text (enum: the names joined with ", ")
  enums?: string[]; // enum value names
  xhtml?: XmlNode[]; // the XHTML content
}

export interface ReqifObject {
  id: string; // the ReqIF identifier
  type: string; // its spec type's name
  lastChange: string;
  values: Map<string, ReqifValue>; // by attribute name
}

export interface ReqifRelation {
  id: string;
  type: string; // the relation type's name
  source: string;
  target: string;
}

export interface ReqifNode {
  object: string;
  children: ReqifNode[];
}

export interface ReqifSpec {
  id: string;
  name: string;
  children: ReqifNode[];
  base: string; // the folder in the archive its file came from, for attachments
}

export interface Reqif {
  title: string;
  objects: Map<string, ReqifObject>;
  relations: ReqifRelation[];
  specs: ReqifSpec[];
  objectBase: Map<string, string>; // object → folder of the .reqif file it came from
}

interface AttrDef {
  name: string;
  kind: ValueKind;
}

const KIND: Record<string, ValueKind> = {
  STRING: 'string',
  XHTML: 'xhtml',
  ENUMERATION: 'enum',
  INTEGER: 'integer',
  REAL: 'real',
  DATE: 'date',
  BOOLEAN: 'boolean',
};

const ref = (el: XmlElement | undefined) => textOf(el ? elements(el)[0] : undefined).trim();

export function emptyReqif(): Reqif {
  return { title: '', objects: new Map(), relations: [], specs: [], objectBase: new Map() };
}

// Reads one .reqif file into `into` (several files merge: DOORS may export one per module).
export function readReqif(xml: string, into: Reqif = emptyReqif(), base = ''): Reqif {
  const doc = parseXml(xml);
  if (doc.local !== 'REQ-IF') throw new Error(`This isn't ReqIF: the document is <${doc.name}>.`);
  const content = find(doc, 'REQ-IF-CONTENT');
  if (!content) throw new Error('The ReqIF file has no content.');
  into.title ||= textOf(find(find(doc, 'REQ-IF-HEADER'), 'TITLE')).trim();

  // Enumeration values: id → name.
  const enumName = new Map<string, string>();
  for (const dt of elements(child(content, 'DATATYPES')))
    for (const v of elements(child(dt, 'SPECIFIED-VALUES'), 'ENUM-VALUE')) enumName.set(v.attrs.IDENTIFIER, v.attrs['LONG-NAME'] ?? v.attrs.IDENTIFIER);

  // Attribute definitions and type names, from every spec type.
  const attrDefs = new Map<string, AttrDef>();
  const typeName = new Map<string, string>();
  for (const t of elements(child(content, 'SPEC-TYPES'))) {
    typeName.set(t.attrs.IDENTIFIER, t.attrs['LONG-NAME'] ?? t.attrs.IDENTIFIER);
    for (const a of elements(child(t, 'SPEC-ATTRIBUTES'))) {
      const m = /^ATTRIBUTE-DEFINITION-(\w+)$/.exec(a.local);
      if (m && KIND[m[1]]) attrDefs.set(a.attrs.IDENTIFIER, { name: a.attrs['LONG-NAME'] ?? a.attrs.IDENTIFIER, kind: KIND[m[1]] });
    }
  }

  const readValues = (el: XmlElement | undefined): Map<string, ReqifValue> => {
    const out = new Map<string, ReqifValue>();
    for (const v of elements(child(el, 'VALUES'))) {
      const m = /^ATTRIBUTE-VALUE-(\w+)$/.exec(v.local);
      if (!m || !KIND[m[1]]) continue;
      const def = attrDefs.get(ref(child(v, 'DEFINITION')));
      const name = def?.name ?? ref(child(v, 'DEFINITION'));
      const kind = KIND[m[1]];
      if (kind === 'xhtml') {
        // DOORS Next sends THE-ORIGINAL-VALUE too; THE-VALUE is the one to show.
        const holder = child(v, 'THE-VALUE') ?? child(v, 'THE-ORIGINAL-VALUE');
        const nodes = holder?.children ?? [];
        out.set(name, { kind, text: textOf(holder).replace(/\s+/g, ' ').trim(), xhtml: nodes });
      } else if (kind === 'enum') {
        const names = elements(child(v, 'VALUES'), 'ENUM-VALUE-REF').map((r) => enumName.get(textOf(r).trim()) ?? textOf(r).trim());
        out.set(name, { kind, text: names.join(', '), enums: names });
      } else out.set(name, { kind, text: v.attrs['THE-VALUE'] ?? '' });
    }
    return out;
  };

  for (const o of elements(child(content, 'SPEC-OBJECTS'), 'SPEC-OBJECT')) {
    const id = o.attrs.IDENTIFIER;
    const values = readValues(o);
    if (o.attrs['LONG-NAME'] && !values.has('ReqIF.Name')) values.set('ReqIF.Name', { kind: 'string', text: o.attrs['LONG-NAME'] });
    into.objects.set(id, { id, type: typeName.get(ref(child(o, 'TYPE'))) ?? '', lastChange: o.attrs['LAST-CHANGE'] ?? '', values });
    into.objectBase.set(id, base);
  }

  for (const r of elements(child(content, 'SPEC-RELATIONS'), 'SPEC-RELATION'))
    into.relations.push({ id: r.attrs.IDENTIFIER, type: typeName.get(ref(child(r, 'TYPE'))) ?? '', source: ref(child(r, 'SOURCE')), target: ref(child(r, 'TARGET')) });

  const hierarchy = (el: XmlElement | undefined): ReqifNode[] =>
    elements(child(el, 'CHILDREN'), 'SPEC-HIERARCHY').map((h) => ({ object: ref(child(h, 'OBJECT')), children: hierarchy(h) }));
  for (const s of elements(child(content, 'SPECIFICATIONS'), 'SPECIFICATION')) {
    const values = readValues(s);
    const name = s.attrs['LONG-NAME'] || values.get('ReqIF.Name')?.text || values.get('ReqIF.ChapterName')?.text || s.attrs.IDENTIFIER;
    into.specs.push({ id: s.attrs.IDENTIFIER, name, children: hierarchy(s), base });
  }
  return into;
}

// Every object in a specification, in document order, with its depth (1: top level).
export function walkSpec(spec: ReqifSpec): { object: string; depth: number; number: string }[] {
  const out: { object: string; depth: number; number: string }[] = [];
  const visit = (nodes: ReqifNode[], depth: number, prefix: string) =>
    nodes.forEach((n, i) => {
      const number = prefix ? `${prefix}.${i + 1}` : String(i + 1);
      out.push({ object: n.object, depth, number });
      visit(n.children, depth + 1, number);
    });
  visit(spec.children, 1, '');
  return out;
}
