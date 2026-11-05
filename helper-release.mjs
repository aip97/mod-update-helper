import {compareVersions, parseReleaseHTML, validatePostURL} from './core.mjs';
import {listKioFiles, downloadKioFile} from './kio-api.mjs';

// The helper itself is released through a Kone post whose body holds a (Base64) Kio collection link.
// The collection carries the signed metadata next to the user ZIP; the native host verifies both.
const ZIP = /^Mod-Update-Helper-User-(\d+\.\d+\.\d+)\.zip$/;
const SIGNATURE = /^wml-updater-release(?:[ _-]v?(\d+\.\d+\.\d+))?\.json$/;
export const HELPER_ZIP_LIMIT = 16 * 1024 * 1024;
const SIGNATURE_LIMIT = 131072;
const fail = (code, message, extra = {}) => Object.assign(new Error(message), {code, ...extra});

export async function helperPostURL(read = async () => (await fetch(chrome.runtime.getURL('self-update-config.json'), {cache:'no-store'})).json()) {
  const config = await read();
  if (typeof config?.postURL !== 'string' || !config.postURL) throw fail('HELPER_UNCONFIGURED', '도우미 배포 게시글이 설정되지 않았습니다.');
  return validatePostURL(config.postURL);
}
function envelopeVersion(text) {
  const envelope = JSON.parse(text);
  if (typeof envelope?.payload !== 'string' || typeof envelope.signature !== 'string') throw new Error('서명 형식 오류');
  const binary = atob(envelope.payload);
  const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, character => character.charCodeAt(0))));
  return payload?.version;
}
export async function findHelperRelease({html, postURL, password, list = listKioFiles, download = downloadKioFile}) {
  postURL = validatePostURL(postURL);
  let post;
  try { post = parseReleaseHTML(html, {modId:'mod-update-helper', postURL}); }
  catch (error) {
    // Kone serves the board list instead of the article body to signed-out visitors.
    if (error.code === 'POST_FORMAT_INVALID' && !/\barticle-prose\b/.test(html)) throw fail('KONE_LOGIN_REQUIRED', '코네 로그인 후 도우미 업데이트를 확인할 수 있습니다. 배포 게시글을 열어 로그인한 뒤 다시 확인해 주세요.', {postURL});
    throw error;
  }
  const zips = [], signatures = [];
  for (const url of post.urls) for (const file of await list({url, password})) {
    if (typeof file.name !== 'string') continue;
    const zip = ZIP.exec(file.name), signature = SIGNATURE.exec(file.name);
    if (zip) zips.push({url, fileName:file.name, size:file.size, version:zip[1]});
    else if (signature) signatures.push({url, fileName:file.name, size:file.size, version:signature[1]});
  }
  if (!zips.length) throw fail('HELPER_RELEASE_MISSING', '배포 게시글의 Kio 컬렉션에서 Mod-Update-Helper-User-<버전>.zip을 찾지 못했습니다.', {postURL});
  zips.sort((a, b) => compareVersions(b.version, a.version));
  if (zips[1]?.version === zips[0].version) throw fail('HELPER_RELEASE_DUPLICATE', '같은 최신 버전의 도우미 ZIP이 여러 개 있습니다.', {postURL});
  const latest = zips[0];
  if (!Number.isSafeInteger(latest.size) || latest.size <= 0 || latest.size > HELPER_ZIP_LIMIT) throw fail('HELPER_RELEASE_INVALID', '도우미 ZIP 크기가 허용 범위(16 MiB)를 벗어났습니다.', {postURL});
  const candidates = signatures.filter(item => item.url === latest.url && (!item.version || item.version === latest.version)
    && Number.isSafeInteger(item.size) && item.size > 0 && item.size <= SIGNATURE_LIMIT)
    .sort((a, b) => (b.version ? 1 : 0) - (a.version ? 1 : 0));
  for (const item of candidates.slice(0, 4)) {
    const bytes = await download({url:item.url, fileName:item.fileName, password, maxBytes:SIGNATURE_LIMIT});
    const envelope = new TextDecoder().decode(bytes);
    try { if (envelopeVersion(envelope) === latest.version) return {version:latest.version, postURL, zip:{url:latest.url, fileName:latest.fileName, size:latest.size}, envelope}; }
    catch {}
  }
  throw fail('HELPER_SIGNATURE_MISSING', `${latest.fileName}과 같은 컬렉션에 버전이 일치하는 서명 파일(wml-updater-release.json)이 없습니다.`, {postURL});
}
