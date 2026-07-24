// Dependency-free .xlsx → rows reader. An .xlsx workbook is a ZIP of XML parts
// (OOXML SpreadsheetML); this turns the first worksheet into the same
// `string[][]` grid the CSV path produces, so pl-extract's table logic is shared
// across both formats. It is DATA ENTRY ASSISTANCE like the rest of pl-extract —
// no LLM, pure parsing — and reads only what a plain financial export needs
// (shared strings, inline strings, numeric cells). Anything it can't read throws
// a clear error, and the UI already tells the advisor to fall back to CSV.
//
// We roll this by hand rather than add a spreadsheet dependency: a P&L export is
// a simple grid, and Node's zlib gives us DEFLATE for free — keeping zero new
// supply-chain surface on a compliance-sensitive product.
import { inflateRawSync } from 'node:zlib';

// --- minimal ZIP reader ----------------------------------------------------
// We resolve entries through the ZIP central directory (not the local file
// headers): Excel commonly streams entries with a data descriptor, which zeroes
// the sizes in the local header — the central directory always carries the true
// compressed size, method, and local-header offset.

interface ZipEntry {
  method: number; // 0 = stored, 8 = deflate
  compressedSize: number;
  localHeaderOffset: number;
}

const EOCD_SIG = 0x06054b50; // End Of Central Directory
const CEN_SIG = 0x02014b50; // Central directory file header
const LOC_SIG = 0x04034b50; // Local file header

function findEocd(buf: Buffer): number {
  // The EOCD sits at the end, before an optional ≤64 KB comment. Scan backward
  // for its signature.
  const min = Math.max(0, buf.length - (0xffff + 22));
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

function readZipEntries(buf: Buffer): Map<string, ZipEntry> {
  if (buf.length < 22 || buf.readUInt32LE(0) !== LOC_SIG) {
    throw new Error('not a valid .xlsx file (missing ZIP signature)');
  }
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('not a valid .xlsx file (no ZIP directory)');
  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16); // offset of first central-directory record

  const entries = new Map<string, ZipEntry>();
  for (let i = 0; i < count; i++) {
    if (ptr + 46 > buf.length || buf.readUInt32LE(ptr) !== CEN_SIG) break;
    const method = buf.readUInt16LE(ptr + 10);
    const compressedSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localHeaderOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);
    entries.set(name, { method, compressedSize, localHeaderOffset });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntry(buf: Buffer, entry: ZipEntry): Buffer {
  const off = entry.localHeaderOffset;
  if (buf.readUInt32LE(off) !== LOC_SIG) throw new Error('corrupt .xlsx (bad local header)');
  const nameLen = buf.readUInt16LE(off + 26);
  const extraLen = buf.readUInt16LE(off + 28);
  const start = off + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(data); // stored
  if (entry.method === 8) return inflateRawSync(data); // deflate
  throw new Error(`unsupported .xlsx compression method ${entry.method}`);
}

// --- XML helpers -----------------------------------------------------------

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&'); // ampersand last so a literal "&amp;lt;" is not double-decoded
}

// All <t>…</t> text inside a chunk, concatenated (a shared string may be split
// across rich-text runs). Self-closing <t/> contributes nothing.
function textOf(xml: string): string {
  let out = '';
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out += m[1];
  return decodeEntities(out);
}

// xl/sharedStrings.xml → the indexed string table cells reference with t="s".
function readSharedStrings(xml: string): string[] {
  const strings: string[] = [];
  const re = /<si>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) strings.push(textOf(m[1]));
  return strings;
}

// The column index (0-based) from a cell reference like "AB12" → 27.
function columnIndex(ref: string): number {
  const letters = (ref.match(/^[A-Z]+/) ?? [''])[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// One worksheet row (<row>…</row>) → a string[] positioned by column letter, so
// gaps between populated cells become empty strings (columns stay aligned).
function parseRow(rowXml: string, shared: string[]): string[] {
  const cells: string[] = [];
  const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let m: RegExpExecArray | null;
  while ((m = cellRe.exec(rowXml))) {
    const attrs = m[1];
    const inner = m[2] ?? '';
    const ref = (attrs.match(/\br="([^"]+)"/) ?? [])[1] ?? '';
    const type = (attrs.match(/\bt="([^"]+)"/) ?? [])[1] ?? 'n';
    const col = ref ? columnIndex(ref) : cells.length;

    let value = '';
    if (type === 's') {
      const v = (inner.match(/<v>([\s\S]*?)<\/v>/) ?? [])[1];
      if (v != null) value = shared[Number(v)] ?? '';
    } else if (type === 'inlineStr') {
      value = textOf(inner);
    } else {
      // number, boolean, or a formula's cached string ("str") — take <v> verbatim.
      const v = (inner.match(/<v>([\s\S]*?)<\/v>/) ?? [])[1];
      value = v != null ? decodeEntities(v) : '';
    }
    if (col >= 0) {
      while (cells.length <= col) cells.push('');
      cells[col] = value;
    }
  }
  return cells;
}

// Pick the workbook's FIRST worksheet: resolve the first <sheet>'s relationship
// to its part; fall back to the lowest-numbered worksheet file. A plain P&L
// export has exactly one sheet, so this is the sheet the advisor exported.
function firstWorksheetPath(entries: Map<string, ZipEntry>, workbookXml: string | null, relsXml: string | null): string | null {
  if (workbookXml && relsXml) {
    const rid = (workbookXml.match(/<sheet\b[^>]*\br:id="([^"]+)"/) ?? [])[1];
    if (rid) {
      const rel = new RegExp(`<Relationship\\b[^>]*\\bId="${rid}"[^>]*>`).exec(relsXml)?.[0] ?? '';
      const target = (rel.match(/\bTarget="([^"]+)"/) ?? [])[1];
      if (target) {
        const path = ('xl/' + target.replace(/^\/?xl\//, '').replace(/^\.\//, '')).replace(/\/{2,}/g, '/');
        if (entries.has(path)) return path;
      }
    }
  }
  const sheets = [...entries.keys()]
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => {
      const na = Number(a.match(/(\d+)\.xml$/)![1]);
      const nb = Number(b.match(/(\d+)\.xml$/)![1]);
      return na - nb;
    });
  return sheets[0] ?? null;
}

// --- entry point -----------------------------------------------------------

// Parse .xlsx bytes into a row grid. Throws on anything that isn't a readable
// single-grid workbook; the caller (pl-extract) surfaces the message and points
// the advisor at CSV as a fallback.
export function xlsxToRows(bytes: Buffer): string[][] {
  const entries = readZipEntries(bytes);
  const get = (name: string): string | null => {
    const e = entries.get(name);
    return e ? readEntry(bytes, e).toString('utf8') : null;
  };

  const sheetPath = firstWorksheetPath(entries, get('xl/workbook.xml'), get('xl/_rels/workbook.xml.rels'));
  if (!sheetPath) throw new Error('no worksheet found in the .xlsx file');
  const sheetXml = get(sheetPath);
  if (sheetXml == null) throw new Error('could not read the .xlsx worksheet');

  const sharedXml = get('xl/sharedStrings.xml');
  const shared = sharedXml ? readSharedStrings(sharedXml) : [];

  const rows: string[][] = [];
  const rowRe = /<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(sheetXml))) {
    const cells = m[1] ? parseRow(m[1], shared) : [];
    // Drop fully-empty rows, mirroring the CSV path's skip_empty_lines.
    if (cells.some((c) => c && c.trim() !== '')) rows.push(cells);
  }
  return rows;
}
