// Reading a DOORS export: a .reqif file, or a .reqifz archive (a zip holding one or
// more .reqif files and the pictures and objects they embed).
import { promises as fs } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { emptyReqif, readReqif, type Reqif } from '../core/reqif';

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
