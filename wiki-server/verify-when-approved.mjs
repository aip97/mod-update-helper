// Retained for future integration; not imported by the deployed handler.
// Do not enable without service permission and a supported authentication method.
import {analyzeReleaseHTML, compareVersions, validateModId, validatePostURL, validateReleaseURL, AIP_ID, POST_URL} from '../core.mjs';
import {listKioFiles, downloadKioFile} from '../kio-api.mjs';
import {inspectPackage, readArchive} from '../installer.mjs';

const ZIP_LIMIT = 4 * 1024 * 1024;
const TOTAL_LIMIT = 8 * 1024 * 1024;
const encoder = new TextDecoder('utf-8', {fatal:true});
const unavailable = message => Object.assign(new Error(message), {manualReview:true});
const bad = message => { throw new Error(message); };
const compact = value => value.toLowerCase().replace(/(?:^|[_-])mod(?=[_-]|$)/g, '').replace(/[ _.-]/g, '');

async function readPost(url, fetcher) {
  let response;
  try { response = await fetcher(validatePostURL(url), {redirect:'error', signal:AbortSignal.timeout(15000)}); }
  catch { throw unavailable('서버에서 게시글에 접근할 수 없어 관리자 확인이 필요합니다.'); }
  if ([401,403,404,429].includes(response.status)) throw unavailable('서버가 게시글에 접근할 수 없어 관리자 확인이 필요합니다.');
  if (!response.ok || !response.body) throw unavailable('서버의 게시글 확인이 완료되지 않았습니다.');
  const reader=response.body.getReader(), parts=[]; let size=0;
  try {
    for (;;) {
      const {done,value}=await reader.read(); if(done) break;
      size+=value.length; if(size>2_000_000) bad('게시글이 너무 큽니다.'); parts.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes=new Uint8Array(size); let offset=0;
  for(const part of parts) {bytes.set(part,offset);offset+=part.length;}
  return encoder.decode(bytes);
}

function candidate(file, modId, url) {
  if(typeof file.name !== 'string' || !/\.zip$/.test(file.name) || /[\\/\x00-\x1f]/.test(file.name)) return null;
  const stem=file.name.slice(0,-4), match=stem.match(/^(.*?)[ _-]v?(\d+\.\d+\.\d+)$/i);
  if(!match || !(match[1]===modId || compact(match[1])===compact(modId))) return null;
  try {compareVersions(match[2],'0.0.0');} catch {return null;}
  if(!Number.isSafeInteger(file.size) || file.size<=0) bad('ZIP 크기가 올바르지 않습니다.');
  return {url,fileName:file.name,version:match[2],size:file.size};
}

export async function verifyPublicRelease(payload, {fetcher=fetch, listFiles=listKioFiles, download=downloadKioFile, kioPassword, kioPasswordUrls=[]}={}) {
  validateModId(payload.mod_id);
  const postURL=validatePostURL(payload.post_url);
  if (kioPassword !== undefined && (typeof kioPassword !== 'string' || !kioPassword.length || kioPassword.length > 256 || !Array.isArray(kioPasswordUrls) || !kioPasswordUrls.length || kioPasswordUrls.length > 8)) throw unavailable('서버의 공유 폴더 인증 설정을 확인해야 합니다.');
  const passwordUrls = new Set(kioPassword === undefined ? [] : kioPasswordUrls.map(validateReleaseURL));
  const passwordFor = url => passwordUrls.has(url) ? kioPassword : undefined;
  let report, html;
  try {html=await readPost(postURL,fetcher);report=analyzeReleaseHTML(html,{modId:payload.mod_id,postURL});}
  catch(error) {if(['KONE_LOGIN_REQUIRED','KONE_ACCESS_REQUIRED'].includes(error.code)) throw unavailable('서버에서 게시글에 로그인할 수 없어 관리자 확인이 필요합니다.');throw error;}
  if(!report.ok && /data-sveltekit-fetched/i.test(html) && !/\barticle-prose\b/i.test(html)) throw unavailable('서버가 게시글 본문을 받지 못해 관리자 확인이 필요합니다.');
  if(!report.ok) bad('게시글에서 유효한 Kio 배포 링크를 확인하지 못했습니다.');
  const found=[];
  try {
    for(const url of report.release.urls) for(const file of await listFiles({url,password:passwordFor(url)})) {
      const item=candidate(file,payload.mod_id,url); if(item) found.push(item);
      if(found.length>32) bad('동일 모드의 ZIP이 너무 많습니다.');
    }
  } catch(error) {
    const detail=typeof error==='string' ? error : String(error?.message || '');
    if(error?.code==='PASSWORD_REQUIRED' || /비밀번호|인증|공유 페이지|요청을 진행|fetch|network/i.test(detail) || kioPassword && detail.includes(kioPassword)) throw unavailable('공유 폴더를 서버가 확인할 수 없어 관리자 확인이 필요합니다.');
    throw error;
  }
  if(!found.length) throw unavailable('서버가 버전이 포함된 모드 ZIP을 찾지 못했습니다. 관리자 확인이 필요합니다.');
  found.sort((a,b)=>compareVersions(b.version,a.version));
  if(found.length>1 && found[0].version===found[1].version) bad('동일 최신 버전 ZIP이 여러 개입니다.');
  const latest=found[0];
  if(latest.version!==payload.version) bad(`신청 버전과 최신 ZIP 버전이 다릅니다: ${latest.version}`);
  if(latest.size>ZIP_LIMIT) throw unavailable('서버의 ZIP 검사 크기 제한을 넘어 관리자 확인이 필요합니다.');
  let bytes;
  try {bytes=await download({...latest,password:passwordFor(latest.url),maxBytes:ZIP_LIMIT});}
  catch(error) {const detail=typeof error==='string' ? error : String(error?.message || '');if(error?.code==='PASSWORD_REQUIRED' || /비밀번호|인증|공유 페이지|요청을 진행|fetch|network/i.test(detail) || kioPassword && detail.includes(kioPassword)) throw unavailable('ZIP에 서버가 접근할 수 없어 관리자 확인이 필요합니다.');throw error;}
  try {await readArchive(bytes,{maxZip:ZIP_LIMIT,maxFile:ZIP_LIMIT,maxTotal:TOTAL_LIMIT,maxEntries:1024});}
  catch(error) {if(/크기|항목 수 제한/.test(error.message)) throw unavailable('서버의 ZIP 검사 한도를 넘어 관리자 확인이 필요합니다.');throw error;}
  const pkg=await inspectPackage(bytes,latest.version,payload.mod_id);
  if(payload.game_spec && pkg.gameSpec!==payload.game_spec) bad(`모드 헤더의 게임 호환성은 ${pkg.gameSpec}입니다.`);
  if(!pkg.supportedWml && payload.wml_versions.length) throw unavailable('ZIP에 WML 호환 선언이 없어 입력한 호환성은 관리자가 확인해야 합니다.');
  if(payload.wml_versions.length && JSON.stringify([...(pkg.supportedWml||[])].sort())!==JSON.stringify([...payload.wml_versions].sort())) bad('WML 호환성 정보가 ZIP 내부 선언과 다릅니다.');
  let source='';
  for(const file of pkg.files) if(/\.(?:m?js)$/i.test(file.path)) source+='\n'+encoder.decode(file.data);
  const generic=source.includes('WML_MOD_UPDATER_QUERY') && source.includes('WML_MOD_UPDATER_STATUS') && source.includes(postURL) && /\bprotocol\s*:\s*2\b/.test(source);
  const legacy=payload.mod_id===AIP_ID && postURL===POST_URL && source.includes('AIP_UPDATER_QUERY') && source.includes('AIP_UPDATER_STATUS') && /\bprotocol\s*:\s*1\b/.test(source);
  const apiVersion=generic ? '2' : legacy ? '1' : null, apiVerified=!!apiVersion;
  const name=[pkg.modNameKo,pkg.modNameEn,pkg.modName].find(value=>typeof value==='string' && value.trim() && value.length<=120) || payload.mod_id;
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
  return {apiVerified,apiVersion,version:pkg.version,name,wmlVersions:pkg.supportedWml||[],gameSpec:pkg.gameSpec,packageSha256:hash};
}
