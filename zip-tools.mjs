// Write a zip the same way everywhere (packaging tools use this instead of an outside program).
//
// Why our own: Windows PowerShell's Compress-Archive writes the path separator as "\", which the zip
// format does not allow (APPNOTE 4.4.17.1 says "/"). Windows tools forgive it, but on Linux, macOS and
// Android the whole path becomes ONE file name — "wml\mods\foo\mod.js" sitting in the top folder.
// A player reported exactly that. Older Windows zip programs have a second problem: they write Korean
// file names in the system code page without the UTF-8 flag, so "모드목록_자동갱신.cmd" comes out as
// mojibake anywhere else. This writer always uses "/" and always marks names as UTF-8.
//
//   zipDir('…/wml-mods-1.3.3', 'wml-mods-1.3.3.zip', { top: 'wml-mods-1.3.3' })
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** zip keeps the modification time as two 16-bit DOS fields, and its clock starts in 1980 */
function dosTime(date) {
  const d = date && date.getFullYear() >= 1980 ? date : new Date(1980, 0, 1);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

const UTF8_FLAG = 0x800;          // bit 11: the name is UTF-8, not the machine's code page
const MADE_BY = (3 << 8) | 20;    // high byte 3 = Unix, so the permissions below are read on Linux/macOS
const NEED = 20;                  // 2.0 — deflate
const MAX32 = 0xffffffff;

/**
 * Write `entries` as a zip file.
 * entries: [{ name, data?, dir?, mtime? }] — `name` always uses "/" and a folder's name ends with "/".
 */
export function writeZip(zipFile, entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const push = b => { chunks.push(b); offset += b.length; };

  for (const e of entries) {
    const isDir = !!e.dir;
    const name = Buffer.from(isDir && !e.name.endsWith('/') ? `${e.name}/` : e.name, 'utf8');
    const raw = isDir ? Buffer.alloc(0) : e.data;
    const { time, date } = dosTime(e.mtime);
    // deflate, unless it comes out no smaller (tiny and already-packed files)
    let method = 0, body = raw;
    if (raw.length) {
      const packed = zlib.deflateRawSync(raw, { level: 9 });
      if (packed.length < raw.length) { method = 8; body = packed; }
    }
    const crc = raw.length ? crc32(raw) : 0;
    if (raw.length > MAX32 || body.length > MAX32) throw new Error(`zip: ${e.name} 이 4GB를 넘어요 (zip64가 필요해요)`);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(NEED, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const at = offset;
    push(local); push(name); if (body.length) push(body);

    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(MADE_BY, 4);
    head.writeUInt16LE(NEED, 6);
    head.writeUInt16LE(UTF8_FLAG, 8);
    head.writeUInt16LE(method, 10);
    head.writeUInt16LE(time, 12);
    head.writeUInt16LE(date, 14);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(body.length, 20);
    head.writeUInt32LE(raw.length, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt16LE(0, 30);     // extra
    head.writeUInt16LE(0, 32);     // comment
    head.writeUInt16LE(0, 34);     // disk
    head.writeUInt16LE(0, 36);     // internal attributes
    // high 16 bits = Unix permissions (drwxr-xr-x / -rw-r--r--), low bit 0x10 = "this is a folder" for Windows
    const mode = isDir ? 0o040755 : 0o100644;
    head.writeUInt32LE(((mode << 16) >>> 0) + (isDir ? 0x10 : 0), 38);
    head.writeUInt32LE(at, 42);
    central.push(Buffer.concat([head, name]));
  }

  const cdAt = offset;
  for (const b of central) push(b);
  const cdSize = offset - cdAt;
  if (entries.length > 0xffff || cdAt > MAX32) throw new Error('zip: 파일이 너무 많거나 커요 (zip64가 필요해요)');

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(cdAt, 16);
  end.writeUInt16LE(0, 20);
  push(end);

  fs.mkdirSync(path.dirname(zipFile), { recursive: true });
  fs.writeFileSync(zipFile, Buffer.concat(chunks));
  return zipFile;
}

/**
 * Zip a whole folder. `top` puts everything inside a folder of that name (what the packages do),
 * and `skip(relativePath, dirent)` leaves a file or folder out.
 */
export function zipDir(srcDir, zipFile, { top = '', skip = null } = {}) {
  const entries = [];
  const prefix = top ? `${top.replace(/[\\/]+$/, '')}/` : '';
  const walk = (dir, rel) => {
    const list = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const d of list) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      const full = path.join(dir, d.name);
      if (skip && skip(r, d)) continue;
      if (d.isDirectory()) {
        entries.push({ name: `${prefix}${r}/`, dir: true, mtime: fs.statSync(full).mtime });
        walk(full, r);
      } else if (d.isFile()) {
        entries.push({ name: `${prefix}${r}`, data: fs.readFileSync(full), mtime: fs.statSync(full).mtime });
      }
    }
  };
  if (prefix) entries.push({ name: prefix, dir: true, mtime: fs.statSync(srcDir).mtime });
  walk(srcDir, '');
  fs.rmSync(zipFile, { force: true });
  return writeZip(zipFile, entries);
}

/** entry names of a zip we wrote — used by the packaging tools to check themselves */
export function readZipNames(zipFile) {
  const buf = fs.readFileSync(zipFile);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 70000; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error(`zip: ${zipFile} 의 끝 기록을 찾지 못했어요`);
  let n = buf.readUInt16LE(eocd + 10), at = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) break;
    const nlen = buf.readUInt16LE(at + 28), elen = buf.readUInt16LE(at + 30), clen = buf.readUInt16LE(at + 32);
    const utf8 = !!(buf.readUInt16LE(at + 8) & UTF8_FLAG);
    out.push({ name: buf.slice(at + 46, at + 46 + nlen).toString(utf8 ? 'utf8' : 'latin1'), utf8 });
    at += 46 + nlen + elen + clen;
  }
  return out;
}

/** throw when a zip would not open properly somewhere else (every packaging tool calls this) */
export function checkZip(zipFile) {
  const names = readZipNames(zipFile);
  const bad = names.filter(e => e.name.includes('\\'));
  if (bad.length) throw new Error(`zip: ${path.basename(zipFile)} 의 경로 구분자가 "\\" 예요 (${bad.length}개). 리눅스·맥에서 폴더가 안 풀려요`);
  const notUtf8 = names.filter(e => !e.utf8 && /[^\x00-\x7f]/.test(e.name));
  if (notUtf8.length) throw new Error(`zip: ${path.basename(zipFile)} 의 한글 이름에 UTF-8 표시가 없어요 (${notUtf8.length}개)`);
  return names.length;
}
