import {parseGameRequirement, gameMatches, supportsWmlVersion, gameFamilyLabel, inspectGameHTML} from './game-compat.mjs';
const LIMIT = 512 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();
const CRC = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(bytes) {
  let c = -1;
  for (const b of bytes) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function need(ok, message) { if (!ok) throw new Error(message); }
function modPrefix(modId) {
  need(typeof modId === 'string' && modId.length <= 64 && /^[a-z0-9][a-z0-9._-]*$/.test(modId)
    && !modId.endsWith('.') && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/.test(modId), '모드 ID 형식이 올바르지 않습니다.');
  return `wml/mods/${modId}/`;
}
function allowedPath(path, modId, isDir) {
  const prefix = modPrefix(modId);
  if (path.startsWith('image-packs/') && safeArchivePath(path)) {
    return isDir || /^image-packs\/.+\/(?:pack\.js|[^/]+\.(?:json|png|jpe?g|webp|gif|avif))$/i.test(path);
  }
  if (isDir && ['wml/', 'wml/mods/', prefix].includes(path)) return true;
  if (!path.startsWith(prefix)) return false;
  const relative = path.slice(prefix.length).replace(/\/$/, '');
  const parts = relative.split('/');
  if (parts.some(p => !p || p.startsWith('.') || /[\\<>:"|?*\x00-\x1f\x7f]/.test(p) || /[. ]$/.test(p)
    || /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(p)
    || /^(?:images?|cache|caches|saves?|config|settings|user-data|userdata|backups?|runtime)(?:\.|$)/i.test(p))) return false;
  return isDir || /\.(?:js|mjs|json|css|html|md|txt|png|jpe?g|webp|gif|svg|ico|woff2?|ttf|otf|mp3|ogg|wav)$/i.test(relative);
}
function safeArchivePath(path) {
  return path.replace(/\/$/, '').split('/').every(part => part && !part.startsWith('.')
    && !/[\\<>:"|?*\x00-\x1f\x7f]/.test(part) && !/[. ]$/.test(part)
    && !/^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part));
}
function versionParts(value) {
  need(typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value), '지원하지 않는 버전 형식입니다.');
  const parts = value.split('.').map(Number);
  need(parts.every(Number.isSafeInteger), '버전 번호가 너무 큽니다.');
  return parts;
}
export function compareVersions(a, b) {
  const left = versionParts(a), right = versionParts(b);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}
function definitionStart(header) {
  const stack=[];
  for(let index=0;index<header.length;index++) {
    const char=header[index],next=header[index+1];
    if(char==='/' && next==='/') {while(index<header.length && !/[\r\n]/.test(header[index])) index++;continue;}
    if(char==='/' && next==='*') {const end=header.indexOf('*/',index+2);need(end>=0,'모드 헤더 주석이 끝나지 않았습니다.');index=end+1;continue;}
    if(['"',"'",'`'].includes(char)) {
      const quote=char;let closed=false;
      for(index++;index<header.length;index++) {
        if(header[index]==='\\') {index++;continue;}
        need(quote!=='`' || header.slice(index,index+2)!=='${','모드 헤더 앞의 동적 템플릿은 지원하지 않습니다.');
        if(header[index]===quote){closed=true;break;}
      }
      need(closed,'모드 헤더 문자열이 끝나지 않았습니다.');continue;
    }
    // shortcut: preamble regex/division requires a full JS tokenizer; stop instead of guessing its boundaries.
    need(char!=='/','모드 선언 앞의 정규식·나눗셈은 지원하지 않습니다. WML.define을 앞에 두세요.');
    if(!stack.length && !/[\w$.]/.test(header[index-1]||' ') && /^WML\s*\.\s*define\s*\(\s*\{/.test(header.slice(index))) return index;
    if('([{'.includes(char)) stack.push(char);
    if(')]}'.includes(char)) need(stack.pop()===({')':'(',']':'[','}':'{'})[char],'모드 선언 앞의 괄호가 맞지 않습니다.');
  }
  throw new Error('첫 12,000자 안의 최상위 WML.define 메타데이터를 확인할 수 없습니다.');
}
function modHeader(text, modId) {
  // shortcut: metadata must precede symbols/setup as literal properties; computed headers need a full JS parser.
  const header = text.slice(0, 12000);
  let at = definitionStart(header);
  const skip = () => {
    const match = /^(?:\s+|\/\/[^\r\n]*(?:[\r\n]+|$)|\/\*[\s\S]*?\*\/)*/.exec(header.slice(at));
    at += match[0].length;
  };
  const take = re => { skip(); const m = re.exec(header.slice(at)); need(m, '모드 메타데이터 형식을 확인할 수 없습니다.'); at += m[0].length; return m; };
  const string = () => take(/^(?:"(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*')/)[0];
  function literal(depth = 0) {
    need(depth < 12, '모드 메타데이터 중첩이 너무 깊습니다.'); skip();
    if (header[at] === '"' || header[at] === "'") return string();
    if (header[at] === '{' || header[at] === '[') {
      const object = header[at++] === '{', end = object ? '}' : ']', values = object ? Object.create(null) : []; skip();
      while (header[at] !== end) {
        let key;
        if (object) { key = take(/^(?:[A-Za-z_$][\w$]*|"(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*')/)[0].replace(/^['"]|['"]$/g, ''); take(/^:/); }
        const value = literal(depth + 1);
        if (object) values[key] = value; else values.push(value);
        skip(); if (header[at] === end) break; take(/^,/); skip();
      }
      at++; return values;
    }
    take(/^(?:true|false|null|-?\d+(?:\.\d+)?)(?=\s|[,}\]])/); return null;
  }
  take(/^WML\s*\.\s*define\s*\(\s*\{/);
  const fields = Object.create(null), seen = new Set();
  for (;;) {
    skip(); if (header[at] === '}') break;
    const key = take(/^(?:[A-Za-z_$][\w$]*|"[A-Za-z_$][\w$]*"|'[A-Za-z_$][\w$]*')/)[0].replace(/^['"]|['"]$/g, '');
    if (key === 'async') {
      skip();
      if (/^setup\s*\(/.test(header.slice(at))) break;
    }
    need(!seen.has(key), '중복된 모드 메타데이터입니다.'); seen.add(key);
    if (key === 'symbols' || key === 'setup') break;
    take(/^:/); const value = literal();
    if (['id', 'version', 'game'].includes(key)) {
      need(typeof value === 'string' && !value.includes('\\'), '모드 메타데이터는 명시적인 문자열이어야 합니다.');
      fields[key] = value.slice(1, -1);
    }
    if (key === 'name') fields.name = value;
    if (key === 'wml') {
      const versions = Array.isArray(value) ? value : [value];
      need(versions.length > 0 && versions.every(v => typeof v === 'string' && !v.includes('\\')), 'wml 메타데이터는 버전 문자열 또는 배열이어야 합니다.');
      fields.supportedWml = versions.map(v => v.slice(1, -1));
      fields.supportedWml.forEach(versionParts);
      need(new Set(fields.supportedWml).size === versions.length, '중복된 WML 버전입니다.');
    }
    skip(); if (header[at] === '}') break; take(/^,/);
  }
  const { id, version, game } = fields;
  need(id === modId, '선택한 모드와 ZIP 모드 ID가 다릅니다.');
  versionParts(version);
  const name = token => {
    if (typeof token !== 'string') return undefined;
    try {
      const decoded = JSON.parse(token[0] === '"' ? token : '"' + token.slice(1, -1).replace(/\\.|"/g, escaped => escaped === "\\'" ? "'" : escaped === '"' ? '\\"' : escaped) + '"');
      return decoded.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 100) || undefined;
    } catch { return undefined; }
  };
  const modNameKo = name(fields.name?.ko), modNameEn = name(fields.name?.en), modName = name(fields.name) || modNameEn || modNameKo;
  return { version, ...parseGameRequirement(game), supportedWml: fields.supportedWml ?? null, ...(modName ? {modName} : {}), ...(modNameKo ? {modNameKo} : {}), ...(modNameEn ? {modNameEn} : {}) };
}
export function evaluateCompatibility(pkg, wmlVersion, gameVersion) {
  return {
    state: pkg.supportedWml == null ? 'unknown' : pkg.supportedWml.includes(wmlVersion) ? 'supported' : 'unsupported', currentWml: wmlVersion, supportedWml: pkg.supportedWml,
    ...(gameVersion === undefined ? {} : { gameState: gameMatches(pkg.gameSpec, gameVersion) ? 'supported' : 'unsupported', currentGame: gameVersion, gameSpec: pkg.gameSpec, gameFamily: pkg.gameFamily }),
  };
}
function requireCompatibility(pkg, installed, allowUnknownWml) {
  const compatibility = evaluateCompatibility(pkg, installed.wmlVersion, installed.gameVersion);
  if (compatibility.gameState === 'unsupported') throw Object.assign(new Error(`게임 호환 불가: 현재 ${gameFamilyLabel(installed.gameFamily)} ${installed.gameVersion}, 모드 지원 ${pkg.gameSpec}.`), compatibility, {code:'GAME_INCOMPATIBLE'});
  if (compatibility.state === 'unsupported' || (compatibility.state === 'unknown' && !allowUnknownWml)) {
    throw Object.assign(new Error(compatibility.state === 'unsupported' ? '이 모드는 선택한 WML 버전을 지원하지 않습니다.' : 'WML 호환 정보가 없습니다. 별도 확인이 필요합니다.'), compatibility, { code: compatibility.state === 'unsupported' ? 'WML_INCOMPATIBLE' : 'WML_COMPAT_UNKNOWN' });
  }
}
async function inflate(data, expected) {
  if (!expected) { need(!data.length, '빈 ZIP 항목의 크기가 다릅니다.'); return new Uint8Array(); }
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader(), result = new Uint8Array(expected);
  let offset = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      need(offset + value.length <= expected, '압축 해제 크기가 선언된 크기를 초과합니다.');
      result.set(value, offset); offset += value.length;
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  need(offset === expected, '압축 해제 크기가 일치하지 않습니다.');
  return result;
}

// Unicode paths are trusted only with a matching checksum of the original filename.
function checkZipExtra(view, start, length, nameBytes) {
  const end = start + length, seen = new Set();
  let unicodePath;
  while (start < end) {
    need(start + 4 <= end, 'ZIP 추가 정보가 손상되었습니다.');
    const id = view.getUint16(start, true), size = view.getUint16(start + 2, true);
    need([0x000a,0x5455,0x7875,0x7075].includes(id) && !seen.has(id) && start + 4 + size <= end, '지원하지 않는 ZIP 추가 정보입니다.');
    if(id===0x7075) {
      need(size>5 && view.getUint8(start+4)===1 && view.getUint32(start+5,true)===crc32(nameBytes),'ZIP Unicode 파일명 검증에 실패했습니다.');
      unicodePath=decoder.decode(new Uint8Array(view.buffer,view.byteOffset+start+9,size-5));
      if(nameBytes.every(byte=>byte<128)) need(unicodePath.replaceAll('\\','/')===decoder.decode(nameBytes).replaceAll('\\','/'),'ZIP 파일명과 Unicode 경로가 다릅니다.');
    }
    seen.add(id); start += 4 + size;
  }
  return unicodePath;
}
// Accept contiguous local entries; ZIP64, encryption and alternate paths remain unsupported.
export async function readArchive(zipBytes, {maxZip=256*1024*1024,maxFile=16*1024*1024,maxTotal=LIMIT,maxEntries=4096} = {}) {
  const bytes = zipBytes instanceof Uint8Array ? zipBytes : new Uint8Array(zipBytes);
  need(bytes.length >= 22 && bytes.length <= maxZip, '업데이트 ZIP 크기가 허용 범위를 벗어났습니다.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = at => view.getUint16(at, true), u32 = at => view.getUint32(at, true);
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && u32(end) !== 0x06054b50) end--;
  need(end >= 0 && u32(end) === 0x06054b50 && end + 22 + u16(end + 20) === bytes.length, 'ZIP 끝 정보가 손상되었습니다.');
  const count = u16(end + 10), cdSize = u32(end + 12), cdOffset = u32(end + 16);
  need(!u16(end + 4) && !u16(end + 6) && count === u16(end + 8) && count <= maxEntries && count > 0, '분할·ZIP64 압축 또는 항목 수 제한을 넘는 압축은 지원하지 않습니다.');
  need(cdOffset + cdSize === end, 'ZIP 파일 목록 위치가 올바르지 않습니다.');
  const entries = [], seen = new Set(), pathCasing = new Map();
  let at = cdOffset, localEnd = 0, total = 0;
  for (let i = 0; i < count; i++) {
    need(at + 46 <= end && u32(at) === 0x02014b50, 'ZIP 파일 목록이 손상되었습니다.');
    const flags = u16(at + 8), method = u16(at + 10), crc = u32(at + 16), packed = u32(at + 20), size = u32(at + 24);
    const nameLength = u16(at + 28), extra = u16(at + 30), comment = u16(at + 32), offset = u32(at + 42);
    need(u16(at + 6) <= 20 && (flags === 0 || flags === 0x800) && (method === 0 || method === 8) && !u16(at + 34), '지원하지 않는 ZIP 압축 형식입니다.');
    need(at + 46 + nameLength + extra + comment <= end, 'ZIP 항목이 잘렸습니다.');
    const nameBytes = bytes.subarray(at + 46, at + 46 + nameLength);
    const unicodePath=checkZipExtra(view,at+46+nameLength,extra,nameBytes);
    if(flags===0x800 && unicodePath!==undefined) need(decoder.decode(nameBytes)===unicodePath,'ZIP UTF-8 파일명과 Unicode 경로가 다릅니다.');
    const path = (unicodePath ?? decoder.decode(nameBytes)).replaceAll('\\', '/');
    const isDir = path.endsWith('/'), mode = u32(at + 38) >>> 16 & 0xf000;
    need(mode === 0 || mode === (isDir ? 0x4000 : 0x8000), '링크나 특수 파일은 설치할 수 없습니다.');
    need(safeArchivePath(path), `허용되지 않은 업데이트 경로: ${path}`);
    need(!seen.has(path.toLowerCase()), '중복된 ZIP 경로입니다.'); seen.add(path.toLowerCase());
    const parts = path.replace(/\/$/, '').split('/');
    for (let j = 1; j <= parts.length; j++) {
      const spelling = parts.slice(0, j).join('/'), key = spelling.toLowerCase();
      need(!pathCasing.has(key) || pathCasing.get(key) === spelling, '중복된 ZIP 경로의 대소문자가 충돌합니다.');
      pathCasing.set(key, spelling);
    }
    need(size <= maxFile && (total += size) <= maxTotal && size <= Math.max(packed * 250, 4096), '압축 해제 크기가 허용 범위를 벗어났습니다.');
    need(offset === localEnd && offset + 30 <= cdOffset && u32(offset) === 0x04034b50, 'ZIP 데이터 위치가 올바르지 않습니다.');
    const ln = u16(offset + 26), le = u16(offset + 28), start = offset + 30 + ln + le;
    need(u16(offset + 4) <= 20 && u16(offset + 6) === flags && u16(offset + 8) === method && u32(offset + 14) === crc && u32(offset + 18) === packed && u32(offset + 22) === size && ln === nameLength, 'ZIP 목록과 파일 정보가 다릅니다.');
    need(start + packed <= cdOffset && nameBytes.every((x, j) => bytes[offset + 30 + j] === x), 'ZIP 파일 이름이나 크기가 다릅니다.');
    const localUnicode=checkZipExtra(view,offset+30+ln,le,nameBytes);
    need(localUnicode===undefined || localUnicode.replaceAll('\\','/')===path,'ZIP 목록과 로컬 Unicode 파일명이 다릅니다.');
    need(!isDir || (!packed && !size), '디렉터리에 파일 데이터가 포함돼 있습니다.');
    const data = method === 0 ? bytes.slice(start, start + packed) : await inflate(bytes.subarray(start, start + packed), size);
    need(data.length === size && crc32(data) === crc, `ZIP 무결성 검사 실패: ${path}`);
    entries.push({ path, data, isDir });
    localEnd = start + packed; at += 46 + nameLength + extra + comment;
  }
  need(at === end && localEnd === cdOffset, 'ZIP 데이터가 일치하지 않습니다.');
  const filePaths=new Set(entries.filter(entry=>!entry.isDir).map(entry=>entry.path.toLowerCase()));
  for(const entry of entries) {
    const parts=entry.path.replace(/\/$/,'').toLowerCase().split('/');
    for(let length=1;length<parts.length;length++) need(!filePaths.has(parts.slice(0,length).join('/')),'파일과 디렉터리 경로가 충돌합니다.');
    if(entry.isDir) need(!filePaths.has(parts.join('/')),'파일과 디렉터리 경로가 충돌합니다.');
  }
  return entries;
}
export async function inspectPackage(zipBytes, expectedVersion, modId = 'attention-image-prompt') {
  const PREFIX = modPrefix(modId);
  if (expectedVersion !== undefined) versionParts(expectedVersion);
  const entries = await readArchive(zipBytes);
  const wrappers = entries.filter(entry => !entry.isDir && entry.path.endsWith('/' + PREFIX + 'mod.js'))
    .map(entry => entry.path.slice(0, -'mod.js'.length));
  const roots = [...new Set(['', `${modId}/`, 'mods/', `mods/${modId}/`, 'wml/mods/', PREFIX, ...wrappers])]
    .filter(root => entries.some(entry => !entry.isDir && entry.path === root + 'mod.js'));
  need(roots.length === 1, roots.length ? '여러 모드 배포 경로가 혼합되어 있습니다.' : '모드 배포 파일이 누락되었거나 지원하지 않는 ZIP 경로입니다.');
  const archiveRoot = roots[0], files = [];
  const gameRoot = archiveRoot.endsWith(PREFIX) ? archiveRoot.slice(0, -PREFIX.length) : '';
  for (const entry of entries) {
    if (entry.isDir && archiveRoot.startsWith(entry.path)) continue;
    const imagePack = entry.path.startsWith(gameRoot + 'image-packs/');
    need(imagePack || entry.path.startsWith(archiveRoot), `허용되지 않은 업데이트 경로: ${entry.path}`);
    const path = imagePack ? entry.path.slice(gameRoot.length) : PREFIX + entry.path.slice(archiveRoot.length);
    need(allowedPath(path, modId, entry.isDir), `허용되지 않은 업데이트 경로: ${entry.path}`);
    if (entry.isDir) continue;
    if (path !== PREFIX + 'mod.js' && /\/mod\.js$/i.test(path)) {
      const source = decoder.decode(entry.data);
      let definesMod=false;
      try {definitionStart(source.slice(0,12000));definesMod=true;} catch {}
      need(!definesMod, '여러 모드 배포 경로가 혼합되어 있습니다.');
    }
    if (/\.html?$/i.test(path)) {
      const html = decoder.decode(entry.data);
      need(!/\bWML_BRIDGE_BEGIN\b|<meta\b[^>]*\bname\s*=\s*['"](?:(?:wf|ot)-version|wml-game)['"]|<script\b[^>]*\bsrc\s*=\s*['"](?:\.\/)?wml\/runtime\/wml-core\.js['"]/i.test(html), '게임 HTML이 포함된 ZIP은 모드 업데이트로 설치할 수 없습니다.');
    }
    files.push({ path, data: entry.data });
  }
  const info = modHeader(decoder.decode(files.find(f => f.path === PREFIX + 'mod.js').data), modId);
  need(expectedVersion === undefined || info.version === expectedVersion, '파일명·승인 버전과 ZIP 내부 모드 버전이 다릅니다.');
  return { ...info, files, archiveRoot };
}

async function parentDirectory(root, path, create = false) {
  const parts = path.split('/'); const name = parts.pop(); let directory = root;
  for (const part of parts) directory = await directory.getDirectoryHandle(part, { create });
  return { directory, name };
}
export async function readFile(root, path) {
  const { directory, name } = await parentDirectory(root, path);
  return (await directory.getFileHandle(name)).getFile();
}
export async function readOptional(root, path, limit = 16 * 1024 * 1024) {
  try {
    const file = await readFile(root, path);
    need(file.size <= limit, '기존 파일 크기가 허용 범위를 벗어났습니다.');
    return new Uint8Array(await file.arrayBuffer());
  }
  catch (error) { if (error.name === 'NotFoundError') return null; throw error; }
}
export async function writeFile(root, path, bytes) {
  const { directory, name } = await parentDirectory(root, path, true);
  const handle = await directory.getFileHandle(name, { create: true });
  const writer = await handle.createWritable();
  try { await writer.write(bytes); await writer.close(); }
  catch (error) { await writer.abort().catch(() => {}); throw error; }
}

export async function readModMetadata(root, modId) {
  const file = await readFile(root, modPrefix(modId) + 'mod.js');
  const {version, ...info} = modHeader(await file.slice(0, 12000).text(), modId);
  return {modVersion:version, ...info};
}

export async function inspectGameDirectory(root, modId = 'attention-image-prompt', options = {}) {
  const modFile = await readFile(root, modPrefix(modId) + 'mod.js');
  const info = modHeader(await modFile.slice(0, 12000).text(), modId);
  return {modVersion:info.version,...await inspectGameRoot(root,options),gameSpec:info.gameSpec,supportedWml:info.supportedWml};
}
export async function inspectGameRoot(root, {gameFile} = {}) {
  need(root?.kind === 'directory', '게임 폴더를 선택해 주세요.');
  const runtime = await (await readFile(root, 'wml/runtime/wml-core.js')).slice(0, 16000).text();
  const wmlVersion = runtime.match(/\bconst VERSION = ['"]([^'"]+)['"]/)?.[1];
  const readHTML = async name => {
    need(typeof name === 'string' && !name.includes('/') && safeArchivePath(name) && /\.html?$/i.test(name), '게임 HTML 파일 이름이 올바르지 않습니다.');
    const file = await readFile(root, name);
    need(file.size <= 64 * 1024 * 1024, '게임 HTML 크기가 허용 범위를 벗어났습니다.');
    return file.text();
  };
  let html;
  if (gameFile !== undefined) html = inspectGameHTML(await readHTML(gameFile));
  else {
    const games = [];
    for await (const entry of root.values()) {
      if (entry.kind !== 'file' || !/\.html?$/i.test(entry.name)) continue;
      const text = await readHTML(entry.name);
      if (!/<script\b[^>]*\bsrc\s*=\s*['"](?:\.\/)?wml\/runtime\/wml-core\.js['"]/i.test(text)) continue;
      games.push({ gameFile: entry.name, ...inspectGameHTML(text) });
    }
    need(games.length === 1, '게임 HTML을 하나로 확인할 수 없습니다. 실행 중인 HTML 파일을 지정해 주세요.');
    ({ gameFile, ...html } = games[0]);
  }
  need(supportsWmlVersion(wmlVersion, html.gameVersion), 'WML 0.9.3 이상의 정식 버전과 현재 프리셋 API가 필요합니다.');
  return { wmlVersion, ...html, gameFile };
}

export function fingerprint(data) { return data === null ? null : { length: data.length, crc: crc32(data) }; }
export function matches(data, length, crc) { return data === null ? length === null && crc === null : data.length === length && crc32(data) === crc; }
async function createBackup(root, modId, previousVersion, version, originals, files) {
  const backupPath = `.wml-mod-updater-backups/${modId}/${new Date().toISOString().replace(/[:.]/g, '-')}-${previousVersion}-${crypto.randomUUID()}`;
  const entries = [];
  let total = 0;
  for (const file of files) {
    const old = originals.get(file.path), original = fingerprint(old), current = fingerprint(file.data);
    need(old === null || (old.length <= 16 * 1024 * 1024 && (total += old.length) <= LIMIT), '백업 크기가 허용 범위를 벗어났습니다.');
    if (old !== null) await writeFile(root, backupPath + '/' + file.path, old);
    entries.push({ path: file.path, existed: old !== null, originalLength: original?.length ?? null, originalCRC: original?.crc ?? null, currentLength: current?.length ?? null, currentCRC: current?.crc ?? null });
  }
  await writeFile(root, backupPath + '/manifest.json', encoder.encode(JSON.stringify({ schema: 1, modId, previousVersion, version, files: entries }, null, 2)));
  await validatedBackup(root, backupPath, modId);
  return backupPath;
}
async function boundedRead(root, path, limit) {
  const file = await readFile(root, path);
  need(file.size <= limit, '백업 파일 크기가 허용 범위를 벗어났습니다.');
  return new Uint8Array(await file.arrayBuffer());
}
async function validatedBackup(root, backupPath, modId) {
  const prefix = `.wml-mod-updater-backups/${modId}/`;
  modPrefix(modId);
  need(typeof backupPath === 'string' && backupPath.startsWith(prefix) && /^[A-Za-z0-9][A-Za-z0-9._-]{0,178}[A-Za-z0-9]$/.test(backupPath.slice(prefix.length)), '허용되지 않은 백업 경로입니다.');
  const manifest = JSON.parse(decoder.decode(await boundedRead(root, backupPath + '/manifest.json', 4 * 1024 * 1024)));
  need(manifest.schema === 1 && manifest.modId === modId, '지원하지 않는 백업 형식 또는 모드입니다.');
  versionParts(manifest.version); versionParts(manifest.previousVersion);
  need(Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length <= 4096, '백업 파일 목록이 올바르지 않습니다.');
  const seen = new Set(), files = []; let total = 0;
  const validHash = (length, crc) => Number.isInteger(length) && length >= 0 && length <= 16 * 1024 * 1024 && Number.isInteger(crc) && crc >= 0 && crc <= 0xffffffff;
  for (const entry of manifest.files) {
    need(entry && typeof entry.path === 'string' && allowedPath(entry.path, modId, false) && !seen.has(entry.path.toLowerCase()), '허용되지 않거나 중복된 백업 파일 경로입니다.');
    seen.add(entry.path.toLowerCase());
    need(typeof entry.existed === 'boolean' && (entry.existed ? validHash(entry.originalLength, entry.originalCRC) : entry.originalLength === null && entry.originalCRC === null), '백업 원본 무결성 정보가 올바르지 않습니다.');
    need(validHash(entry.currentLength, entry.currentCRC) || (entry.currentLength === null && entry.currentCRC === null), '백업 설치본 무결성 정보가 올바르지 않습니다.');
    total += (entry.originalLength || 0) + (entry.currentLength || 0);
    need(total <= LIMIT * 2, '백업 합계 크기가 허용 범위를 벗어났습니다.');
    const data = entry.existed ? await boundedRead(root, backupPath + '/' + entry.path, 16 * 1024 * 1024) : null;
    need(matches(data, entry.originalLength, entry.originalCRC), '백업 원본 파일이 누락되거나 손상되었습니다.');
    files.push({ path: entry.path, data });
  }
  for (const name of seen) need(![...seen].some(other => other.startsWith(name + '/')), '백업 파일 경로가 충돌합니다.');
  const mod = files.find(f => f.path === modPrefix(modId) + 'mod.js');
  need(mod?.data, '백업 원본 모드 버전이 다릅니다.');
  const info = modHeader(decoder.decode(mod.data), modId);
  need(info.version === manifest.previousVersion, '백업 원본 모드 버전이 다릅니다.');
  return { manifest, files, info };
}
export async function listBackups(root, modId = 'attention-image-prompt') {
  modPrefix(modId);
  let directory;
  try { directory = await root.getDirectoryHandle('.wml-mod-updater-backups').then(d => d.getDirectoryHandle(modId)); }
  catch (error) { if (error.name === 'NotFoundError') return []; throw error; }
  const backups = [];
  Object.defineProperty(backups, 'rejected', { value: [] });
  for await (const entry of directory.values()) {
    if (entry.kind !== 'directory') continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,178}[A-Za-z0-9]$/.test(entry.name)) continue;
    const backupPath = `.wml-mod-updater-backups/${modId}/${entry.name}`;
    try { const { manifest, info } = await validatedBackup(root, backupPath, modId); backups.push({ ...manifest, backupPath, gameSpec: info.gameSpec, gameFamily: info.gameFamily, supportedWml: info.supportedWml }); }
    catch (error) {
      if (backups.rejected.length < 100) backups.rejected.push({ backupPath, reason: String(error.message || '백업 검증 실패').slice(0, 300) });
    }
  }
  return backups.sort((a, b) => b.backupPath.localeCompare(a.backupPath));
}
export async function replaceFile(root, path, data) {
  if (data !== null) return writeFile(root, path, data);
  try { const { directory, name } = await parentDirectory(root, path); await directory.removeEntry(name); }
  catch (error) { if (error.name !== 'NotFoundError') throw error; }
}
export async function restoreBackup(root, backupPath, { modId = 'attention-image-prompt', expectedInstalledVersion, gameFile, allowUnknownWml = false } = {}) {
  const { manifest, files, info } = await validatedBackup(root, backupPath, modId);
  const installed = await inspectGameDirectory(root, modId, {gameFile});
  need(installed.modVersion === expectedInstalledVersion && installed.modVersion === manifest.version, '백업 이후 설치 버전이 변경되었습니다.');
  requireCompatibility(info, installed, allowUnknownWml);
  const originals = new Map();
  for (const entry of manifest.files) {
    const current = await readOptional(root, entry.path);
    need(matches(current, entry.currentLength, entry.currentCRC), '백업 이후 파일이 변경되었습니다. 복원을 중단합니다.');
    originals.set(entry.path, current);
  }
  const protectivePath = await createBackup(root, modId, installed.modVersion, manifest.previousVersion, originals, files);
  const rechecked = await inspectGameDirectory(root, modId, {gameFile:installed.gameFile});
  need(rechecked.modVersion === installed.modVersion && rechecked.wmlVersion === installed.wmlVersion && rechecked.gameVersion === installed.gameVersion && rechecked.gameFile === installed.gameFile && rechecked.htmlVersion === installed.htmlVersion, '복원 준비 중 설치 버전이 변경되었습니다.');
  for (const entry of manifest.files) need(matches(await readOptional(root, entry.path), entry.currentLength, entry.currentCRC), '복원 준비 중 파일이 변경되었습니다.');
  const ordered = [...files].sort((a, b) => Number(a.path === modPrefix(modId) + 'mod.js') - Number(b.path === modPrefix(modId) + 'mod.js'));
  const touched = [];
  try {
    for (const file of ordered) { touched.push(file.path); await replaceFile(root, file.path, file.data); }
    for (const file of ordered) need(matches(await readOptional(root, file.path), file.data?.length ?? null, file.data === null ? null : crc32(file.data)), '복원 후 파일 검사에 실패했습니다.');
  } catch (error) {
    const failed = [];
    for (const path of touched.reverse().sort((a, b) => Number(a === modPrefix(modId) + 'mod.js') - Number(b === modPrefix(modId) + 'mod.js'))) {
      try {
        await replaceFile(root, path, originals.get(path));
        const old = originals.get(path);
        need(matches(await readOptional(root, path), old?.length ?? null, old === null ? null : crc32(old)), '복구 검사 실패');
      } catch { failed.push(path); }
    }
    throw new Error(`${error.message} ${failed.length ? '일부 파일을 복원하지 못했습니다: ' + failed.join(', ') : '변경한 파일을 이전 상태로 복원했습니다.'} 백업: ${protectivePath}`);
  }
  return { version: manifest.previousVersion, previousVersion: installed.modVersion, backupPath: protectivePath, filesWritten: files.length };
}

// All live-file writes happen after package validation, backups, and a second version check.
export async function applyUpdate(root, zipBytes, { modId = 'attention-image-prompt', expectedVersion, expectedInstalledVersion, allowUnknownWml = false, gameFile } = {}) {
  const PREFIX = modPrefix(modId);
  const pkg = await inspectPackage(zipBytes, expectedVersion, modId);
  const installed = await inspectGameDirectory(root, modId, {gameFile});
  need(installed.modVersion === expectedInstalledVersion, '선택 후 설치 버전이 변경되었습니다. 다시 확인해 주세요.');
  need(compareVersions(pkg.version, installed.modVersion) > 0, '같거나 이전 버전은 설치하지 않습니다.');
  requireCompatibility(pkg, installed, allowUnknownWml);
  const originals = new Map();
  for (const file of pkg.files) {
    const old = await readOptional(root, file.path);
    need(!old || old.length <= 16 * 1024 * 1024, '기존 파일 크기가 허용 범위를 벗어났습니다.');
    originals.set(file.path, old);
  }
  const backupPath = await createBackup(root, modId, installed.modVersion, pkg.version, originals, pkg.files);
  const rechecked = await inspectGameDirectory(root, modId, {gameFile:installed.gameFile});
  need(rechecked.modVersion === installed.modVersion && rechecked.wmlVersion === installed.wmlVersion && rechecked.gameVersion === installed.gameVersion && rechecked.gameFile === installed.gameFile && rechecked.htmlVersion === installed.htmlVersion, '백업 중 설치 버전이 변경되었습니다.');
  for (const [path, old] of originals) need(matches(await readOptional(root, path), old?.length ?? null, old === null ? null : crc32(old)), '백업 중 파일이 변경되었습니다.');
  const touched = [];
  // Publish mod.js last so interrupted updates do not claim the new version prematurely.
  const ordered = [...pkg.files].sort((a, b) => Number(a.path === PREFIX + 'mod.js') - Number(b.path === PREFIX + 'mod.js'));
  try {
    for (const file of ordered) { touched.push(file.path); await writeFile(root, file.path, file.data); }
    for (const file of ordered) {
      const actual = await readOptional(root, file.path);
      need(actual && actual.length === file.data.length && crc32(actual) === crc32(file.data), '설치 후 파일 검사에 실패했습니다.');
    }
  } catch (error) {
    const failed = [];
    for (const path of touched.reverse().sort((a, b) => Number(a === PREFIX + 'mod.js') - Number(b === PREFIX + 'mod.js'))) {
      try {
        const old = originals.get(path);
        await replaceFile(root, path, old);
        need(matches(await readOptional(root, path), old?.length ?? null, old === null ? null : crc32(old)), '복구 검사 실패');
      } catch { failed.push(path); }
    }
    throw new Error(`${error.message} ${failed.length ? '일부 파일을 복원하지 못했습니다: ' + failed.join(', ') : '변경한 파일을 이전 상태로 복원했습니다.'} 백업: ${backupPath}`);
  }
  return { version: pkg.version, previousVersion: installed.modVersion, backupPath, filesWritten: pkg.files.length };
}
