// Reading a DOORS export: a .reqif file, or a .reqifz archive (a zip holding one or
// more .reqif files and the pictures and objects they embed), or modules exported as HTML.
import { promises as fs, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { emptyReqif, readReqif, type Reqif } from '../core/reqif';
import { readDoorsHtml } from '../core/doorshtml';

export interface ZipEntry {
  name: string;
  data: () => Buffer;
}

export function unzip(buf: Buffer): ZipEntry[] {
  // The end of central directory record, searched from the end (a comment may follow it).
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--)
    if (buf.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0) throw new Error('This isn’t a zip archive (.reqifz).');
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  if (at === 0xffffffff) throw new Error('This archive is too large to read here (zip64).');
  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error('The archive’s directory is damaged.');
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const raw = buf.subarray(at + 46, at + 46 + nameLen);
    const name = (flags & 0x0800 ? raw.toString('utf8') : raw.toString('latin1')).replace(/\\/g, '/');
    at += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (flags & 1) throw new Error(`${name} in the archive is encrypted.`);
    out.push({
      name,
      data: () => {
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        const body = buf.subarray(start, start + size);
        if (method === 0) return Buffer.from(body);
        if (method === 8) return inflateRawSync(body);
        throw new Error(`${name} in the archive uses a compression this can’t read (method ${method}).`);
      },
    });
  }
  return out;
}

export interface DoorsExport {
  reqif: Reqif;
  attachment: (path: string) => Uint8Array | null;
  files: string[]; // the .reqif files read
}

// One export file, or several read as one (modules exported separately, with the links
// between them): an object's pictures are looked for in each file in turn.
export async function readExport(file: string | string[]): Promise<DoorsExport> {
  const reqif = emptyReqif();
  const lookups: DoorsExport['attachment'][] = [];
  const files: string[] = [];
  for (const f of Array.isArray(file) ? file : [file]) {
    const one = await readOne(f, reqif);
    lookups.push(one.attachment);
    files.push(...one.files);
  }
  return { reqif, attachment: (path) => lookups.reduce<Uint8Array | null>((hit, look) => hit ?? look(path), null), files };
}

// A DOORS module exported as HTML (one file per module, several read together), with the
// pictures DOORS writes beside it. `notes` says what was found in each file.
export async function readHtmlExport(files: string[]): Promise<DoorsExport & { notes: string[] }> {
  const read = await Promise.all(files.map(async (f, i) => ({ name: f, html: decodeHtml(await fs.readFile(f)), key: `f${i}` })));
  const { reqif, embedded, notes } = readDoorsHtml(read);
  return {
    reqif,
    notes,
    files,
    attachment: (path) => {
      const hit = embedded.get(path);
      if (hit) return hit;
      const m = /^f(\d+)\/(.+)$/.exec(path);
      // Only pictures, and only files: nothing else is copied into the repository.
      if (!m || !files[Number(m[1])] || !/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(m[2])) return null;
      const full = join(dirname(files[Number(m[1])]), ...m[2].split('/'));
      try {
        return statSync(full).isFile() ? new Uint8Array(readFileSync(full)) : null;
      } catch {
        return null;
      }
    },
  };
}

// HTML's bytes as text: a byte order mark, else the charset it declares, else UTF-8 if it
// is valid UTF-8, else Windows-1252 (what DOORS 9 on Windows usually writes).
export function decodeHtml(buf: Buffer): string {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  const head = buf.subarray(0, 4096).toString('latin1');
  const declared = /<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i.exec(head)?.[1];
  if (declared)
    try {
      return new TextDecoder(declared.toLowerCase()).decode(buf);
    } catch {
      // An unknown charset: guess below.
    }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

async function readOne(file: string, reqif: Reqif): Promise<Omit<DoorsExport, 'reqif'>> {
  const buf = await fs.readFile(file);
  // A zip starts with PK; anything else is read as ReqIF XML.
  if (buf.readUInt32LE(0) !== 0x04034b50) {
    readReqif(buf.toString('utf8'), reqif);
    return { attachment: () => null, files: [file] };
  }
  const entries = unzip(buf);
  const reqifs = entries.filter((e) => /\.reqif$/i.test(e.name));
  if (!reqifs.length) throw new Error(`${file}: the archive has no .reqif file in it.`);
  for (const e of reqifs) readReqif(e.data().toString('utf8'), reqif, e.name.includes('/') ? e.name.slice(0, e.name.lastIndexOf('/')) : '');
  const byName = new Map(entries.map((e) => [e.name, e]));
  const lower = new Map(entries.map((e) => [e.name.toLowerCase(), e]));
  return {
    attachment: (path) => {
      const e = byName.get(path) ?? lower.get(path.toLowerCase());
      return e ? new Uint8Array(e.data()) : null;
    },
    files: reqifs.map((e) => `${file}: ${e.name}`),
  };
}
