// Spreadsheets without a library: an Excel workbook (.xlsx, which is a zip of XML
// parts) and CSV. Text is written as text, never as a formula.

// pct: a fraction shown as 0%; tone: text on a coloured fill (a test result, a verdict).
export type Tone = 'good' | 'bad' | 'warn' | 'muted';
export type Cell = string | number | null | { pct: number } | { text: string; tone: Tone };

export interface Column {
  header: string;
  width: number; // in characters
  wrap?: boolean; // long text: wrap within the cell
}

export interface Sheet {
  name: string;
  columns: Column[];
  rows: Cell[][];
}

// ---- zip (stored, no compression: the files are small and Excel reads it as is) ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zip(files: { name: string; data: Uint8Array }[], date = new Date()): Uint8Array {
  const enc = new TextEncoder();
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((Math.max(date.getFullYear(), 1980) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, f.data.length, true);
    local.setUint32(22, f.data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), name, f.data);

    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true);
    c.setUint16(12, dosTime, true);
    c.setUint16(14, dosDate, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, f.data.length, true);
    c.setUint32(24, f.data.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), name);
    offset += 30 + name.length + f.data.length;
  }
  const centralSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ---- the workbook ----

const xmlText = (s: string) =>
  s
    // Characters XML can't hold at all.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export function columnName(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// Excel's rules for sheet names: 31 characters, none of []:*?/\, unique.
function sheetNames(sheets: Sheet[]): string[] {
  const used = new Set<string>();
  return sheets.map((s) => {
    const base = s.name.replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31) || 'Sheet';
    let name = base;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base.slice(0, 31 - String(i).length - 1)} ${i}`;
    used.add(name.toLowerCase());
    return name;
  });
}

const MAX_CELL = 32767; // characters Excel keeps in a cell

// Styles: 0 plain (top-aligned), 1 header, 2 wrapped text, 3 percent, 4–7 the tones.
const TONE_STYLE: Record<Tone, number> = { good: 4, bad: 5, warn: 6, muted: 7 };
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="6"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font>${['FF0B5A48', 'FF8A2C10', 'FF6B520B', 'FF6F6F6A'].map((c) => `<font><sz val="11"/><color rgb="${c}"/><name val="Calibri"/><family val="2"/></font>`).join('')}</fonts>
<fills count="6"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>${['FFE6EEFB', 'FFD9F0E7', 'FFF9DCCF', 'FFF6ECC6'].map((c) => `<fill><patternFill patternType="solid"><fgColor rgb="${c}"/><bgColor indexed="64"/></patternFill></fill>`).join('')}</fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="8">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top"/></xf>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="top"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top"/></xf>
${[
  [2, 3],
  [3, 4],
  [4, 5],
  [5, 0],
]
  .map(([font, fill]) => `<xf numFmtId="0" fontId="${font}" fillId="${fill}" borderId="0" xfId="0" applyFont="1"${fill ? ' applyFill="1"' : ''} applyAlignment="1"><alignment vertical="top"/></xf>`)
  .join('\n')}
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function sheetXml(sheet: Sheet): string {
  const cell = (v: Cell, ref: string, style: number): string => {
    if (v == null || v === '') return '';
    if (typeof v === 'number') return Number.isFinite(v) ? `<c r="${ref}"${style ? ` s="${style}"` : ''}><v>${v}</v></c>` : '';
    if (typeof v === 'object' && 'pct' in v) return `<c r="${ref}" s="3"><v>${v.pct}</v></c>`;
    if (typeof v === 'object') return cell(v.text, ref, TONE_STYLE[v.tone]);
    const t = xmlText(v.length > MAX_CELL ? v.slice(0, MAX_CELL - 1) + '…' : v);
    return `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ''}><is><t${/^\s|\s$|\n/.test(v) ? ' xml:space="preserve"' : ''}>${t}</t></is></c>`;
  };
  const header = `<row r="1">${sheet.columns.map((c, i) => cell(c.header, `${columnName(i)}1`, 1)).join('')}</row>`;
  const rows = sheet.rows.map((r, ri) => `<row r="${ri + 2}">${sheet.columns.map((c, ci) => cell(r[ci] ?? null, `${columnName(ci)}${ri + 2}`, c.wrap ? 2 : 0)).join('')}</row>`);
  const last = `${columnName(Math.max(sheet.columns.length - 1, 0))}${sheet.rows.length + 1}`;
  const cols = sheet.columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width}" customWidth="1"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<dimension ref="A1:${last}"/>
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
${cols ? `<cols>${cols}</cols>` : ''}
<sheetData>${header}${rows.join('')}</sheetData>
${sheet.columns.length ? `<autoFilter ref="A1:${last}"/>` : ''}
</worksheet>`;
}

export function xlsx(sheets: Sheet[], props: { title?: string; date?: Date } = {}): Uint8Array {
  const enc = new TextEncoder();
  const names = sheetNames(sheets);
  const date = props.date ?? new Date();
  const iso = date.toISOString().replace(/\.\d+Z$/, 'Z');
  const files: [string, string][] = [
    [
      '[Content_Types].xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`,
    ],
    [
      '_rels/.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`,
    ],
    [
      'docProps/core.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${xmlText(props.title ?? '')}</dc:title><dc:creator>Tracey</dc:creator>
<dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${iso}</dcterms:modified>
</cp:coreProperties>`,
    ],
    [
      'xl/workbook.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<bookViews><workbookView/></bookViews>
<sheets>${names.map((n, i) => `<sheet name="${xmlText(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
<definedNames>${sheets
        .map((s, i) =>
          s.columns.length
            ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${xmlText(names[i].replace(/'/g, "''"))}'!$A$1:$${columnName(s.columns.length - 1)}$${s.rows.length + 1}</definedName>`
            : '',
        )
        .join('')}</definedNames>
</workbook>`,
    ],
    [
      'xl/_rels/workbook.xml.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    ],
    ['xl/styles.xml', STYLES],
    ...sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)] as [string, string]),
  ];
  return zip(
    files.map(([name, text]) => ({ name, data: enc.encode(text) })),
    date,
  );
}

// ---- CSV ----

// A cell starting with = + - @ (or a tab/CR) would run as a formula when opened in a
// spreadsheet; a leading ' keeps it text.
const safe = (s: string) => (/^[=+\-@\t\r]/.test(s) ? `'${s}` : s);

export function csv(sheet: Sheet): string {
  const field = (v: Cell): string => {
    if (v == null) return '';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'object') return 'pct' in v ? `${Math.round(v.pct * 100)}%` : field(v.text);
    const s = safe(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [sheet.columns.map((c) => field(c.header)), ...sheet.rows.map((r) => sheet.columns.map((_, i) => field(r[i] ?? null)))].map((r) => r.join(','));
  // The byte-order mark makes Excel read it as UTF-8.
  return '﻿' + lines.join('\r\n') + '\r\n';
}
