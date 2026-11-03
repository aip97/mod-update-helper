import {parseGameVersion, supportsWmlVersion} from './game-compat.mjs';
export const POST_URL = 'https://kone.gg/s/somisoft/d7dNsfio5zS0D3neJOhkeb';
export const AIP_ID = 'attention-image-prompt';
export function validateSnapshot(value) {
  const version = v => typeof v === 'string' && v.length > 0 && v.length <= 64 && !/[\x00-\x1f]/.test(v);
  if (!value || !Array.isArray(value.mods) || value.mods.length > 500 || !version(value.wmlVersion) || !version(value.gameVersion)) return null;
  let identity;
  try {
    identity = parseGameVersion(value.gameVersion);
    if (value.htmlVersion !== undefined && parseGameVersion(value.htmlVersion).gameVersion !== identity.gameVersion) return null;
    if (value.gameFamily !== undefined && value.gameFamily !== identity.gameFamily) return null;
  } catch { return null; }
  const ids = new Set(), mods = [];
  for (const mod of value.mods) {
    if (!mod || typeof mod.id !== 'string' || !mod.id || mod.id.length > 100 || /[\x00-\x1f]/.test(mod.id) || typeof mod.version !== 'string' || mod.version.length > 64 || /[\x00-\x1f]/.test(mod.version) || ids.has(mod.id)) return null;
    ids.add(mod.id);
    let reason;
    try { validateModId(mod.id); compareVersions(mod.version, '0.0.0'); compareVersions(value.wmlVersion, '0.0.0'); } catch { reason = mod.version ? '모드 ID 또는 버전 형식을 지원하지 않습니다.' : '모드 버전이 없습니다.'; }
    if (!supportsWmlVersion(value.wmlVersion, value.gameVersion)) reason = '이 게임 계열의 WML 버전은 지원하지 않습니다.';
    mods.push({modId: mod.id, modVersion: mod.version, active: true, supported: !reason, ...(reason ? {reason} : {})});
  }
  let gameUpdate, gameUpdateError;
  if (value.gameUpdate !== undefined) {
    try { gameUpdate = validateGameUpdateAPI(value.gameUpdate); }
    catch (error) { gameUpdateError = error.message; }
  }
  return {mods, wmlVersion: value.wmlVersion, ...identity, ...(value.htmlVersion ? {htmlVersion: value.htmlVersion} : {}), ...(gameUpdate ? {gameUpdate} : {}), ...(gameUpdateError ? {gameUpdateError} : {})};
}
export function validateGameUpdateAPI(value) {
  const need = (ok, message) => { if (!ok) throw new Error(message); };
  need(value?.protocol === 1 && Array.isArray(value.packages) && value.packages.length > 0 && value.packages.length <= 8, '게임 업데이트 API 형식이 올바르지 않습니다.');
  const postURL = validatePostURL(value.postURL), ids = new Set();
  const safe = name => typeof name === 'string' && name.length <= 200 && name.split('/').every(part => part && !part.startsWith('.') && !/[\\<>:"|?*\x00-\x1f]/.test(part) && !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part));
  const packages = value.packages.map(item => {
    need(item && /^[a-z][a-z0-9-]{0,31}$/.test(item.id) && !ids.has(item.id), '게임 배포판 ID가 올바르지 않거나 중복되었습니다.'); ids.add(item.id);
    need(typeof item.label === 'string' && item.label.length > 0 && item.label.length <= 60 && !/[\x00-\x1f]/.test(item.label), '게임 배포판 이름이 올바르지 않습니다.');
    for (const key of ['file','html']) {
      const template = item[key];
      need(safe(template) && !template.includes('/') && (template.match(/\{version\}/g)?.length || 0) === (key === 'file' ? 1 : template.includes('{version}') ? 1 : 0) && !/[{}]/.test(template.replace('{version}','1.0.0')) && (key === 'file' ? /\.zip$/i : /\.html?$/i).test(template), '게임 ZIP·HTML 파일명 규칙을 확인하세요. ZIP에는 {version}이 한 번 필요합니다.');
    }
    return {id:item.id,label:item.label,file:item.file,html:item.html};
  });
  const preserve = value.preserve ?? [];
  need(Array.isArray(preserve) && preserve.length <= 32 && preserve.every(safe), '보존할 게임 데이터 경로가 올바르지 않습니다.');
  return {protocol:1,postURL,packages,preserve:[...new Set(preserve)]};
}
export function enrichMod(mod, api, manual) {
  let apiPostURL, apiError;
  if (api?.postURL !== undefined) {
    try { apiPostURL = validatePostURL(api.postURL); } catch { apiError = 'API 게시글 주소가 올바르지 않습니다.'; }
  }
  let manualURL;
  try { if (manual?.postURL) manualURL = validatePostURL(manual.postURL); } catch {}
  return {...mod, apiSupported: !!api, ...(api?.modName ? {modName: api.modName} : {}), ...(apiPostURL ? {apiPostURL} : {}), ...(apiError ? {apiError} : {}), postURL: apiPostURL || manualURL, source: apiPostURL ? 'api' : manualURL ? 'manual' : 'none'};
}
const VERSION = /^(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})$/;
export function validateModId(value) {
  if (typeof value !== 'string' || value.length > 64 || !/^[a-z0-9][a-z0-9._-]*$/.test(value) || value.endsWith('.') || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value)) throw new Error('잘못된 모드 ID입니다.');
  return value;
}
export function compareVersions(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !VERSION.test(a) || !VERSION.test(b)) throw new Error('버전 형식을 확인할 수 없습니다.');
  const aa = a.split('.').map(Number), bb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return Math.sign(aa[i] - bb[i]);
  return 0;
}
export function validatePostURL(value) {
  try {
    const url = new URL(value);
    if (url.origin !== 'https://kone.gg' || !/^\/s\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]{22}$/.test(url.pathname) || url.search || url.hash || url.username || url.password) throw new Error('Kone 게시글의 직접 주소(/s/공간/게시글ID)를 입력하세요.');
    return url.href;
  } catch (error) { error.code = 'POST_URL_INVALID'; throw error; }
}
export function validateStatus(value) {
  try {
    if (!value || ![1, 2].includes(value.protocol) || (value.protocol === 1 && value.modId !== AIP_ID)) return null;
    if (value.protocol === 2 && typeof value.active !== 'boolean') return null;
    validateModId(value.modId);
    compareVersions(value.modVersion, '0.0.0'); compareVersions(value.wmlVersion, '0.0.0');
    if (typeof value.gameVersion !== 'string' || !/^[\w.\-]{1,64}$/.test(value.gameVersion)) return null;
    if (value.modName !== undefined && (typeof value.modName !== 'string' || !value.modName.trim() || value.modName.length > 100 || /[\x00-\x1f]/.test(value.modName))) return null;
    return {protocol: value.protocol, modId: value.modId, modVersion: value.modVersion, wmlVersion: value.wmlVersion, gameVersion: value.gameVersion, ...(value.protocol === 2 ? {active: value.active} : {}),
      ...(value.modName === undefined ? {} : {modName: value.modName}), ...(value.postURL === undefined ? {} : {postURL: validatePostURL(value.postURL)})};
  } catch { return null; }
}
export function validateReleaseURL(value) {
  const url = new URL(value);
  if (url.origin !== 'https://kio.ac' || !/^\/c\/[a-d][A-Za-z0-9_-]{21}$/.test(url.pathname) || url.search || url.hash || url.username || url.password) throw new Error('허용된 Kio 공유 링크가 아닙니다.');
  return url.href;
}
// Diagnostics are displayed as text; redact URL credentials even in rejected input.
function diagnosticText(value) {
  return String(value ?? '').replace(/https?:\/\/[^\s<>"'()]+/gi, raw => {
    try { const url = new URL(raw); return `${url.protocol}//${url.host}${url.pathname}${url.search || url.hash || url.username || url.password ? ' [인증·추가 정보 숨김]' : ''}`; }
    catch { return '[잘못된 URL]'; }
  }).replace(/[\x00-\x1f]/g, ' ').slice(0, 240);
}
export function analyzeRelease(title, text, {modId = AIP_ID, postURL = POST_URL} = {}) {
  validateModId(modId);
  title = typeof title === 'string' ? title : '';
  text = typeof text === 'string' ? text.slice(0, 2_000_000) : '';
  const checks = [];
  const add = (id, label, status, location, actual, expected, feedback) => checks.push({id,label,status,location,actual:diagnosticText(actual),expected,feedback});
  let validPost;
  try { validPost = validatePostURL(postURL); } catch {}
  add('post_url','게시글 주소',validPost ? 'pass' : 'error','등록한 게시글 주소',postURL,'Kone 게시글 직접 주소',validPost ? '코네 게시글 직접 주소입니다.' : '코네 게시글을 연 뒤 주소창의 직접 주소를 복사하세요.');
  add('title_id','게시글 제목','pass','게시글 제목',title || '(제목 없음)','자유 형식','제목과 파일명은 달라도 됩니다. 모드 ID와 버전은 공유 폴더의 ZIP 파일명으로 확인합니다.');
  const urls = new Set(), problems = [];
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'()]+/gi)) {
    if (!/kio\./i.test(match[0])) continue;
    try { urls.add(validateReleaseURL(match[0])); } catch { problems.push('사용할 수 없는 Kio 주소: ' + diagnosticText(match[0])); }
  }
  for (const match of text.matchAll(/\baHR0c[HD][^\s<>"'()]{0,1024}/g)) {
    try { urls.add(validateReleaseURL(atob(match[0]))); } catch { problems.push('Base64 링크가 깨졌거나 허용된 Kio 공유 주소가 아닙니다.'); }
  }
  const linkOK = urls.size > 0 && urls.size <= 8 && !problems.length;
  add('kio_link','Kio 컬렉션 링크',linkOK ? 'pass' : 'error','게시글 본문',problems.join(' ') || [...urls].join(', ') || '(링크 없음)','Kio HTTPS 공유 주소 또는 Base64, 최대 8개',
    linkOK ? '같은 링크는 한 번만 확인합니다. 여러 모드가 있는 컬렉션도 지원합니다.' : problems.length ? problems.join(' ') : urls.size > 8 ? '공유 링크가 너무 많습니다. 현재 배포 컬렉션만 남겨 주세요.' : '본문에 Kio 공유 주소 또는 해당 주소의 Base64를 넣으세요. 다운로드 제목이나 버전 표기는 필수가 아닙니다.');
  add('collection_files','컬렉션의 모드 파일','warning','Kio 파일 목록','아직 확인하지 않음',modId + ' 1.2.3.zip (버전은 예시)','상태 확인 시 정확한 모드 ID의 ZIP 중 가장 높은 버전을 찾습니다. 같은 최신 버전 파일이 중복되면 선택하지 않습니다.');
  add('zip_contents','ZIP 파일 확인','warning','공유 링크의 ZIP 파일','아직 다운로드하거나 검사하지 않음','파일명과 내부 mod.js의 ID·버전 일치','파일명 확인 후에도 설치 승인 뒤 ZIP 구조와 내부 모드 ID·버전·게임 호환성을 검사합니다.');
  const ok = checks.every(check => check.status !== 'error');
  return {ok,modId,postURL:validPost || diagnosticText(postURL),title:diagnosticText(title),
    ...(ok ? {release:{modId,urls:[...urls],postURL:validPost}} : {}),checks};
}
function releaseFromDiagnostic(diagnostic) {
  if (!diagnostic.ok) throw Object.assign(new Error(diagnostic.checks.find(check => check.status === 'error')?.feedback || '게시글 형식을 확인하세요.'), {code: diagnostic.checks.find(check => check.id === 'post_url')?.status === 'error' ? 'POST_URL_INVALID' : 'POST_FORMAT_INVALID'});
  return diagnostic.release;
}
export function parseRelease(title, text, options) {
  return releaseFromDiagnostic(analyzeRelease(title, text, options));
}
function balancedElement(html, start, tag) {
  const tokens = new RegExp('</?' + tag + '\\b[^>]*>', 'gi'); tokens.lastIndex=start;
  let depth=0;
  for (let match; (match=tokens.exec(html));) {
    depth += match[0].startsWith('</') ? -1 : 1;
    if (!depth) return {start,end:tokens.lastIndex,html:html.slice(start,tokens.lastIndex)};
  }
  return null;
}
export function analyzeReleaseHTML(html, options) {
  if (typeof html !== 'string' || html.length > 2_000_000) throw Object.assign(new Error('게시글 응답 크기가 올바르지 않습니다. 2MB 이내의 게시글이 필요합니다.'), {code: 'POST_FORMAT_INVALID'});
  const decode = text => text.replace(/&(?:nbsp|#160);/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (_, hex, dec) => { const n = parseInt(hex || dec, hex ? 16 : 10); return n <= 0x10ffff ? String.fromCodePoint(n) : ''; });
  const clean = html.replace(/<!--[\s\S]*?-->/g,'').replace(/<(script|style|nav|header|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  const title = decode(clean.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
  const loginTitle = /^(?:로그인|log\s*in|sign\s*in)(?:\s*[-|·]\s*(?:kone|코네))?$/i.test(title.trim());
  const loginForm = /(?:로그인|\blog\s*in\b|\bsign\s*in\b)/i.test(title) && /<form\b/i.test(clean) && /<input\b[^>]*\btype\s*=\s*(?:["']password["']|password(?=[\s>]))/i.test(clean);
  const prose=/<div\b[^>]*\bclass=["'][^"']*\barticle-prose\b[^"']*["'][^>]*>/i.exec(clean);
  let body = (prose && balancedElement(clean,prose.index,'div')?.html) || clean.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1] || clean.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] || clean;
  const visible = decode(body.replace(/<[^>]+>/g,' ')).replace(/\s+/g,' ').trim();
  const loginGate = !prose && visible.length < 2000 && /로그인(?:이|을)?\s*(?:필요|해야|해\s*주세요|해주세요)|로그인\s*후.{0,30}(?:확인|열람|이용|접근)|(?:log|sign)\s*in\s+(?:to\s+(?:view|read|continue|access)|required)/i.test(visible);
  if (loginTitle || loginForm || loginGate) throw Object.assign(new Error('코네 로그인 후 이용해 주세요. 게시글을 열어 로그인 및 접근 권한을 확인한 뒤 다시 시도하세요. 게시글 형식은 아직 검사하지 않았습니다.'), {code: 'KONE_LOGIN_REQUIRED'});
  if (!prose && visible.length < 2000 && /(?:접근|열람|조회)\s*권한이\s*없|권한이\s*필요|성인\s*인증|연령\s*인증|비공개\s*게시글|access\s*denied|permission\s*required/i.test(visible)) throw Object.assign(new Error('게시글 접근이 제한되어 있습니다. 코네에서 로그인·인증·열람 권한을 확인한 뒤 다시 진단하세요. 게시글 형식은 아직 검사하지 않았습니다.'), {code:'KONE_ACCESS_REQUIRED'});
  const folded=[]; const details=/<details\b[^>]*>/gi;
  for(let match; (match=details.exec(body));) {
    const block=balancedElement(body,match.index,'details'); if(!block) break;
    folded.push(block); details.lastIndex=block.end;
  }
  let unfolded=body; for(const block of [...folded].reverse()) unfolded=unfolded.slice(0,block.start)+' '+unfolded.slice(block.end);
  const downloads=value=>[...decode(value.replace(/<[^>]+>/g,' ')).matchAll(/다운로드\s*\((\d+\.\d+\.\d+)\)/g)].map(m=>m[1]).filter(v=>VERSION.test(v));
  const current=downloads(unfolded).sort((a,b)=>compareVersions(b,a))[0];
  // A collapsed older download section is an archive, not an additional active collection.
  for(const block of [...folded].reverse()) {
    const summary=block.html.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/i)?.[1] || '';
    const versions=downloads(summary);
    if(current && versions.length===1 && compareVersions(versions[0],current)<0) body=body.slice(0,block.start)+' '+body.slice(block.end);
  }
  const text = body.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_, attrs, label) => {
    const href = attrs.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    return `${label} ${href ? decode(href[1] ?? href[2] ?? href[3]) : ''} `;
  }).replace(/<[^>]+>/g, ' ');
  return analyzeRelease(title, decode(text).replace(/\s+/g, ' '), options);
}
export function parseReleaseHTML(html, options) {
  return releaseFromDiagnostic(analyzeReleaseHTML(html, options));
}
