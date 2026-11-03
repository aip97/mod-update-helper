import {Encoder, decode, setSizeLimits} from './vendor/cbor-x-1.6.4.mjs';
import {compareVersions, validateModId} from './core.mjs';
import {inspectPackage} from './installer.mjs';

// Protocol fields verified against kiodl and the current Kio download service (see THIRD_PARTY_NOTICES.md).
const API = 'https://api.kio.ac/v0/collection/';
const MAX_BYTES = 256 * 1024 * 1024;
const encoder = new Encoder({useRecords:false, tagUint8Array:false});
setSizeLimits({maxArraySize: 10000, maxMapSize: 10000});
const get = (value, key) => value instanceof Map ? value.get(key) : value?.[key];
const need = (ok, message) => { if (!ok) throw new Error(message); };

function shareUuid(value) {
  const url = new URL(value);
  need(url.origin === 'https://kio.ac' && !url.username && !url.password && !url.hash && !url.search
    && /^\/c\/[a-d][a-zA-Z0-9_-]{21}$/.test(url.pathname), '허용된 Kio 공유 주소가 아닙니다.');
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-';
  let number = 0n;
  for (const character of url.pathname.slice(3)) number = number * 64n + BigInt(alphabet.indexOf(character));
  return Uint8Array.from({length:16}, (_, i) => Number(number >> BigInt(8 * i) & 255n));
}
function uuid(value) { need(value instanceof Uint8Array && value.length === 16, 'Kio 파일 식별자가 올바르지 않습니다.'); return value; }
function token(value) { need(typeof value === 'string' && value.length > 0 && value.length < 16384 && !/[\r\n]/.test(value), 'Kio 접근 응답을 확인할 수 없습니다.'); return value; }
async function boundedBytes(response, limit, exact = null) {
  need(response.body, '다운로드 응답에 파일 데이터가 없습니다.');
  const announced = response.headers.get('content-length');
  if (announced !== null) need(/^\d+$/.test(announced) && Number(announced) <= limit, '다운로드 크기가 허용 범위를 초과했습니다.');
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read(); if (done) break;
      size += value.length; need(size <= limit, '다운로드 크기가 허용 범위를 초과했습니다.'); chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  need(exact === null || size === exact, '다운로드 파일 조각 크기가 일치하지 않습니다.');
  const output = new Uint8Array(size); let at = 0;
  for (const part of chunks) { output.set(part, at); at += part.length; }
  return output;
}
async function post(path, data, headers = {}) {
  const response = await fetch(API + path, {
    method:'POST', headers:{'Content-Type':'application/cbor', Accept:'application/cbor', ...headers},
    body:encoder.encode(data), credentials:'omit', redirect:'error', signal:AbortSignal.timeout(30000),
  });
  need(response.status === 200 || response.status === 418, `Kio 요청을 진행할 수 없습니다 (${response.status}). 공유 페이지에서 확인해 주세요.`);
  const type = response.headers.get('content-type') || '';
  need(type.includes('application/cbor'), 'Kio 응답 형식이 변경됐거나 브라우저 확인이 필요합니다.');
  let body;
  try { body = decode(await boundedBytes(response, 1024 * 1024)); }
  catch { throw new Error('Kio 응답을 해석하지 못했습니다. 공유 페이지에서 확인해 주세요.'); }
  return {status:response.status, body};
}

async function collectionFiles(url, password) {
  const share = shareUuid(url);
  let collection = await post('get', {uuid:share});
  if (collection.status === 418) {
    need(get(get(collection.body, 'meta'), 'type') === 'password', '이 공유 링크는 자동 입력을 지원하지 않는 인증이 필요합니다.');
    if (typeof password !== 'string' || !password.length || password.length > 256) throw Object.assign(new Error('공유 비밀번호를 입력하면 파일 목록에서 버전을 확인합니다.'), {code:'PASSWORD_REQUIRED'});
    collection = await post('get', {uuid:share, protector:[{type:'password', data:new Map([['password', password]])}]});
  }
  if (collection.status !== 200) throw Object.assign(new Error('공유 비밀번호를 확인해 주세요.'), {code:'PASSWORD_REQUIRED'});
  const cat = token(get(collection.body, 'token'));
  const segmentSize = Number(get(collection.body, 'segment_size'));
  need(Number.isSafeInteger(segmentSize) && segmentSize > 0 && segmentSize <= MAX_BYTES, 'Kio 파일 조각 크기를 확인할 수 없습니다.');
  const dirs = [uuid(get(collection.body, 'root'))], seen = new Set(), candidates = [];
  while (dirs.length) {
    need(seen.size < 32, '공유 폴더 구조가 너무 큽니다.');
    const id = dirs.shift(), key = [...id].join(',');
    need(!seen.has(key), '공유 폴더에 순환 참조가 있습니다.'); seen.add(key);
    const directory = await post('directory/get', {id}, {'Kiosk-CAT':cat});
    need(directory.status === 200, '공유 폴더를 읽지 못했습니다.');
    const files = get(directory.body, 'files') || [], children = get(directory.body, 'children') || [];
    need(Array.isArray(files) && files.length <= 1000 && Array.isArray(children) && children.length <= 32, '공유 폴더 목록이 올바르지 않습니다.');
    candidates.push(...files);
    need(candidates.length <= 10000 && dirs.length + children.length <= 32, '공유 폴더 구조가 너무 큽니다.');
    for (const child of children) dirs.push(uuid(get(child, 'id')));
  }
  return {files:candidates, cat, segmentSize};
}
export async function listKioFiles({url,password}) {
  const {files}=await collectionFiles(url,password);
  return files.map(file=>({name:get(file,'name'),size:Number(get(file,'size'))}));
}
function modFile(file, modId) {
  const name = get(file, 'name');
  if (typeof name !== 'string' || /[\\/\x00-\x1f]/.test(name) || !name.endsWith('.zip')) return null;
  const stem = name.slice(0,-4), match = stem.match(/^(.*?)[ _-]v?(\d+\.\d+\.\d+)$/i);
  const identity = match ? match[1] : stem;
  const compact = value => value.toLowerCase().replace(/(?:^|[_-])mod(?=[_-]|$)/g,'').replace(/[ _.-]/g,'');
  if (identity !== modId && !(match && compact(identity) === compact(modId))) return null;
  const version = match?.[2];
  if (version) try { compareVersions(version, '0.0.0'); } catch { return null; }
  const size = Number(get(file, 'size'));
  need(Number.isSafeInteger(size) && size > 0 && size <= MAX_BYTES, '모드 ZIP이 256 MiB 제한을 초과하거나 비어 있습니다.');
  return {version, fileName:name, size};
}
// A versionless filename needs a read-only ZIP inspection; installation still requires confirmation.
export async function findKioRelease({urls, password, modId}) {
  validateModId(modId);
  need(Array.isArray(urls) && urls.length > 0 && urls.length <= 8, '공유 링크가 없거나 너무 많습니다.');
  const candidates = [];
  for (const url of new Set(urls)) {
    const collection = await collectionFiles(url, password);
    for (const file of collection.files) {
      const info = modFile(file, modId);
      if (info) candidates.push({...info, url});
    }
  }
  need(candidates.length > 0, `${modId} 버전.zip 파일을 찾지 못했습니다. 파일명에 정확한 모드 ID와 버전을 넣어 주세요.`);
  need(candidates.length <= 32, '이 모드의 배포 파일이 너무 많습니다. 이전 버전을 정리해 주세요.');
  for (const candidate of candidates.filter(item => !item.version)) {
    const bytes = await downloadKioApi({url:candidate.url,fileName:candidate.fileName,modId,password});
    candidate.version = (await inspectPackage(bytes,undefined,modId)).version;
    candidate.versionSource = 'header';
  }
  candidates.sort((a,b) => compareVersions(b.version,a.version));
  need(candidates.length === 1 || candidates[0].version !== candidates[1].version, '같은 모드의 최신 버전 ZIP이 여러 개라 하나로 확인하지 못했습니다.');
  return {modId, ...candidates[0]};
}
export async function downloadKioApi({url, version, modId = 'attention-image-prompt', fileName = `${modId} ${version}.zip`, password}) {
  validateModId(modId); if (version !== undefined) compareVersions(version, '0.0.0');
  const requested = modFile({name:fileName,size:1},modId);
  need(requested && (!requested.version || version === undefined || requested.version === version), '승인한 모드 파일명이 올바르지 않습니다.');
  return downloadKioFile({url,fileName,password});
}
export async function downloadKioFile({url,fileName,password,maxBytes=MAX_BYTES}) {
  need(typeof fileName==='string' && fileName.length<=240 && !/[\\/\x00-\x1f]/.test(fileName) && fileName.endsWith('.zip'), '배포 파일명이 올바르지 않습니다.');
  need(Number.isSafeInteger(maxBytes) && maxBytes>0 && maxBytes<=512*1024*1024,'다운로드 제한이 올바르지 않습니다.');
  const {files, cat, segmentSize} = await collectionFiles(url, password);
  const candidates = files.filter(file => get(file, 'name') === fileName);
  need(candidates.length === 1, '승인한 버전의 모드 ZIP을 하나로 확인하지 못했습니다.');
  const file = candidates[0], size=Number(get(file,'size')), id = uuid(get(file, 'id'));
  need(Number.isSafeInteger(size) && size>0 && size<=maxBytes,`ZIP이 ${maxBytes/1024/1024} MiB 제한을 초과하거나 비어 있습니다.`);
  const reply = await post('file/gets', {ids:[id]}, {'Kiosk-CAT':cat, 'Kiosk-Download-Capability':'cdn'});
  const items = get(reply.body, 'files');
  need(reply.status === 200 && Array.isArray(items) && items.length === 1, '모드 파일 다운로드 응답을 확인하지 못했습니다.');
  const segments = get(items[0], 'segments');
  need(Array.isArray(segments) && segments.length === Math.ceil(size / segmentSize) && segments.length <= 128, '파일 조각 개수가 실제 파일 크기와 다릅니다.');
  const output = new Uint8Array(size); let at = 0;
  for (const segment of segments) {
    // shortcut: allow the CDN host observed for this release only; review new hosts before enabling them.
    need(get(segment, 'type') === 'cdn', '이 공유 파일은 아직 지원하지 않는 전송 방식을 사용합니다.');
    const address = new URL(get(get(segment, 'data'), 'url'));
    need(address.origin === 'https://dalet.mittere.io' && !address.username && !address.password && !address.hash
      && /^\/[a-f0-9]{64}$/.test(address.pathname), '허용된 파일 전송 주소가 아닙니다.');
    const expected = Math.min(segmentSize, size - at);
    const response = await fetch(address.href, {credentials:'omit', redirect:'error', signal:AbortSignal.timeout(60000)});
    need(response.status === 200, `파일 다운로드를 진행할 수 없습니다 (${response.status}).`);
    const part = await boundedBytes(response, expected, expected); output.set(part, at); at += part.length;
  }
  need(at === size, '다운로드가 완료되지 않았습니다.');
  return output.buffer;
}
