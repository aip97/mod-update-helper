import {compareVersions, parseReleaseHTML, analyzeRelease, analyzeReleaseHTML, validateSnapshot, enrichMod, validateModId, validatePostURL, validateReleaseURL} from './core.mjs';
import {findKioRelease} from './kio-api.mjs';
import {startSelfUpdates} from './self-update.mjs';
import {gameSource,findGameRelease} from './game-release.mjs';
import {compareGameVersions} from './game-compat.mjs';
async function passwordSettings() {
  const {kioDefaultPassword} = await chrome.storage.local.get('kioDefaultPassword');
  return {passwordConfigured:typeof kioDefaultPassword === 'string', defaultPassword:typeof kioDefaultPassword === 'string' ? kioDefaultPassword : ''};
}
async function settings() {
  const {registrations = {}} = await chrome.storage.local.get('registrations');
  return registrations;
}
async function fetchPostHTML(postURL) {
  postURL = validatePostURL(postURL);
  let response;
  try {
    response = await fetch(postURL, {cache: 'no-store', credentials: 'include', redirect: 'manual', signal: AbortSignal.timeout(20000)});
  } catch (error) {
    throw new Error(error.name === 'TimeoutError' || error.name === 'AbortError'
      ? '게시글 확인 시간이 초과되었습니다. 연결 상태를 확인하고 다시 시도하세요.'
      : 'Kone 게시글 연결에 실패했습니다. 네트워크 상태와 게시글 주소를 확인하고 다시 시도하세요.');
  }
  if (response.status === 401 || response.status === 403 || response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    throw Object.assign(new Error('코네 로그인 후 이용해 주세요. 게시글을 열어 로그인 및 접근 권한을 확인한 뒤 다시 시도하세요.'), {code: 'KONE_LOGIN_REQUIRED'});
  }
  if (!response.ok) throw new Error(`게시글 확인 실패 (${response.status})`);
  if (Number(response.headers.get('content-length')) > 2_000_000) throw new Error('게시글 응답이 너무 큽니다.');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let html = '', size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 2_000_000) throw new Error('게시글 응답이 너무 큽니다.');
      html += decoder.decode(value, {stream: true});
    }
    html += decoder.decode();
  } finally { await reader.cancel(); }
  return html;
}
async function resolveCollection(post) {
  const saved = await passwordSettings();
  try { return {...await findKioRelease({urls:post.urls,modId:post.modId,password:saved.passwordConfigured ? saved.defaultPassword : undefined}),postURL:post.postURL,checkedAt:Date.now()}; }
  catch (error) {
    if (error.code === 'PASSWORD_REQUIRED') return {...post,passwordRequired:true,checkedAt:Date.now()};
    throw error;
  }
}
async function latest(modId, postURL, force = false) {
  validateModId(modId); postURL = validatePostURL(postURL);
  const key = 'release-' + modId;
  const stored = await chrome.storage.local.get(key), cached = stored[key];
  if (!force && cached?.postURL === postURL && Date.now() - cached.checkedAt < 3600000) return cached;
  const release = await resolveCollection(parseReleaseHTML(await fetchPostHTML(postURL), {modId, postURL}));
  if (!release.passwordRequired) await chrome.storage.local.set({[key]: release});
  return release;
}
async function latestGame(game, force=false, edition) {
  const source=gameSource(game);
  if(!source) return {source:null};
  const editionKey='game-edition-'+game.gameFamily;
  const saved=await chrome.storage.local.get(editionKey);
  edition ??= saved[editionKey] || source.packages[0].id;
  if(!source.packages.some(item=>item.id===edition)) throw new Error('게임 배포판을 다시 선택해 주세요.');
  const key='game-release-'+game.gameFamily+'-'+edition, stored=await chrome.storage.local.get(key), signature=JSON.stringify(source);
  let release=stored[key];
  if(force || release?.sourceSignature!==signature || Date.now()-release.checkedAt<0 || Date.now()-release.checkedAt>=3600000) {
    const savedPassword=await passwordSettings();
    release={...await findGameRelease({html:await fetchPostHTML(source.postURL),game,source,edition,password:savedPassword.passwordConfigured?savedPassword.defaultPassword:undefined}),sourceSignature:signature};
    await chrome.storage.local.set({[key]:release});
  }
  return {source,release,edition,available:compareGameVersions(release.gameVersion,game.gameVersion)>0};
}
async function notifyGameUpdate(game, force=false) {
  try {
    const result=await latestGame(game,force);
    if(!result.available) return false;
    const current=(await chrome.storage.session.get('game-'+game.tabId))['game-'+game.tabId];
    if(current?.documentId!==game.documentId) return false;
    await chrome.tabs.sendMessage(game.tabId,{type:'GAME_UPDATE_AVAILABLE',current:game.gameVersion,version:result.release.gameVersion},{documentId:game.documentId});
    await chrome.action.setBadgeText({tabId:game.tabId,text:'NEW'});
    return true;
  } catch {return false;}
}
async function diagnosePost(modId, postURL) {
  const base = analyzeRelease('', '', {modId, postURL});
  const urlCheck = base.checks.find(check => check.id === 'post_url');
  const zipCheck = base.checks.find(check => check.id === 'zip_contents');
  let report;
  if (urlCheck.status !== 'pass') {
    report = {...base, checks: [urlCheck, {id:'access',label:'게시글 접근',status:'blocked',location:'게시글 연결',actual:'요청하지 않음',expected:'조회용 Kone 게시글 주소',feedback:'게시글 주소를 먼저 고쳐 주세요. 아직 서버에 접속하지 않았습니다.'}, zipCheck]};
  } else {
    try {
      report = analyzeReleaseHTML(await fetchPostHTML(postURL), {modId, postURL});
      report.checks.splice(1, 0, {id:'access',label:'게시글 접근',status:'pass',location:'Kone 게시글',actual:'본문 읽기 성공',expected:'로그인 및 접근 권한이 있는 게시글',feedback:'게시글을 읽어 작성 형식을 검사했습니다.'});
      if (report.ok) {
        const check = report.checks.find(item => item.id === 'collection_files');
        try {
          const found = await resolveCollection(report.release);
          if (found.passwordRequired) Object.assign(check,{status:'warning',actual:'비밀번호 필요',feedback:'기본 비밀번호를 설정한 뒤 다시 진단하면 파일명을 검사할 수 있습니다.'});
          else {
            Object.assign(check,{status:'pass',location:`${found.url} → ${found.fileName}`,actual:found.fileName,expected:`${modId} ${found.version}.zip`,feedback:`${found.versionSource==='header'?'파일명에 버전이 없지만 ZIP 내부 헤더':'파일명'} 기준 ${found.version} 버전입니다. 게시글 제목과 달라도 사용할 수 있습니다.${found.versionSource==='header'?` 빠른 감지를 위한 권장 파일명: ${modId} ${found.version}.zip. 내부 헤더 위치: wml/mods/${modId}/mod.js (포장 폴더 허용).`:''}`});
            if(found.versionSource==='header') Object.assign(report.checks.find(item=>item.id==='zip_contents'),{status:'pass',actual:'ZIP 내부 ID·버전 확인 완료',feedback:'파일명에 버전이 없어 ZIP을 읽어 검사했습니다. 파일은 설치하지 않았으며, 설치 시 다시 검사합니다.'});
            report.release=found;report.version=found.version;
          }
        } catch (error) { report.ok=false; Object.assign(check,{status:'error',actual:'파일 확인 실패',feedback:error.message}); }
      }
    } catch(error) {
      report = {...base, checks: [urlCheck,
        {id:'access',label:'게시글 접근',status:'error',location:'Kone 게시글',code:error.code || 'NETWORK_ERROR',actual:'게시글을 검사하지 못함',expected:'접근 가능한 게시글',feedback:error.message},
        {id:'content',label:'제목·본문 형식',status:'blocked',location:'게시글 제목과 본문',actual:'아직 확인하지 못함',expected:'게시글 읽기 성공',feedback:'접근 문제를 해결한 뒤 다시 진단하세요. 게시글 형식이 잘못되었다고 판정한 것은 아닙니다.'},zipCheck]};
    }
  }
  return {...report, checkedAt:Date.now()};
}
const fail = (code, message) => Object.assign(new Error(message), {code});
let writes = Promise.resolve();
function mutate(fn) { const result = writes.then(fn); writes = result.catch(() => {}); return result; }
async function openUI(tabId, modId) {
  const query = new URLSearchParams();
  if (Number.isInteger(tabId)) query.set('tabId', tabId);
  if (modId) query.set('modId', validateModId(modId));
  const base = chrome.runtime.getURL('update.html');
  const existing = (await chrome.tabs.query({})).find(tab => tab.url?.split('?')[0] === base && [null, String(tabId)].includes(new URL(tab.url).searchParams.get('tabId')));
  const opened = existing
    ? await chrome.tabs.update(existing.id, {active: true, ...(!new URL(existing.url).searchParams.has('tabId') ? {url: base + '?' + query} : {})})
    : await chrome.tabs.create({url: base + '?' + query});
  if (Number.isInteger(opened?.windowId)) await chrome.windows.update(opened.windowId, {focused: true});
  if (existing) chrome.runtime.sendMessage({type: 'UPDATES_AVAILABLE', tabId}).catch(() => {});
}
chrome.action.onClicked.addListener(tab => openUI(tab.id));
async function clearGame(tabId) {
  await mutate(async () => {
    await chrome.storage.session.remove('game-' + tabId);
    await chrome.storage.session.remove('opened-update-' + tabId);
    await chrome.storage.session.remove('notify-check-' + tabId);
    await chrome.storage.session.remove('helper-check-' + tabId);
    const {lastGame} = await chrome.storage.session.get('lastGame');
    if (lastGame?.tabId === tabId) await chrome.storage.session.remove('lastGame');
  });
}
chrome.tabs.onRemoved.addListener(tabId => { clearGame(tabId).catch(() => {}); });
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading') { clearGame(tabId).catch(() => {}); chrome.action.setBadgeText({tabId, text: ''}).catch(() => {}); }
});
function metadata(values) {
  const result = Object.create(null);
  if (!Array.isArray(values) || values.length > 500) return result;
  for (const value of values) {
    if (!value || ![1, 2].includes(value.protocol) || (value.protocol === 1 && value.modId !== 'attention-image-prompt')) continue;
    try { validateModId(value.modId); } catch { continue; }
    if (value.protocol === 2 && typeof value.active !== 'boolean') continue;
    if (result[value.modId]?.protocol === 2 && value.protocol === 1) continue;
    const item = {protocol: value.protocol};
    if (typeof value.modName === 'string' && value.modName.length <= 100 && !/[\x00-\x1f]/.test(value.modName)) item.modName = value.modName;
    if (value.postURL !== undefined) item.postURL = typeof value.postURL === 'string' && value.postURL.length <= 2048 ? value.postURL : '';
    result[value.modId] = item;
  }
  return result;
}
async function decorate(game) {
  const registered = await settings();
  const cached = await chrome.storage.local.get(game.mods.map(mod => 'release-' + mod.modId));
  return {...game, mods: game.mods.map(item => {
    const mod = enrichMod(item, game.api?.[item.modId], registered[item.modId]), release = cached['release-' + item.modId];
    if (mod.supported && release?.modId === mod.modId && release.postURL === mod.postURL && Number.isFinite(release.checkedAt) && Date.now() - release.checkedAt >= 0 && Date.now() - release.checkedAt < 3600000) {
      try {
        compareVersions(release.version, mod.modVersion);
        mod.cachedRelease = {modId: release.modId, version: release.version, fileName:release.fileName, url: validateReleaseURL(release.url), postURL: release.postURL, checkedAt: release.checkedAt};
      } catch {}
    }
    return mod;
  })};
}
async function saveSnapshot(reply, sender, expected) {
  const snapshot = validateSnapshot(reply?.snapshot);
  if (!snapshot) throw fail('SNAPSHOT_UNAVAILABLE', 'WML 활성 모드 목록을 읽지 못했습니다. 게임을 새로고침해 주세요.');
  return mutate(async () => {
    const key = 'game-' + sender.tab.id;
    if (expected) {
      const current = (await chrome.storage.session.get(key))[key];
      if (!current || current.documentId !== expected.documentId || current.url !== expected.url) throw fail('CONTEXT_CHANGED', '게임 탭이 변경되었습니다.');
    }
    const game = {tabId: sender.tab.id, url: sender.url, documentId: sender.documentId, ...snapshot, api: metadata(reply.apis), seenAt: Date.now()};
    await chrome.storage.session.set({[key]: game, lastGame: game});
    return game;
  });
}
async function freshGame(tabId) {
  const stored = await chrome.storage.session.get(['game-' + tabId, 'lastGame']);
  const game = Number.isInteger(tabId) ? stored['game-' + tabId] : stored.lastGame;
  if (!game?.documentId) return null;
  try {
    const before = await chrome.tabs.get(game.tabId);
    if (before.url !== game.url) throw new Error('changed');
    const reply = await chrome.tabs.sendMessage(game.tabId, {type: 'READ_SNAPSHOT'}, {documentId: game.documentId});
    const after = await chrome.tabs.get(game.tabId);
    if (after.url !== game.url) throw new Error('changed');
    return decorate(await saveSnapshot(reply, {tab: {id: game.tabId}, url: game.url, documentId: game.documentId}, game));
  } catch (error) {
    if (error.code) throw error;
    throw fail('CONTEXT_CHANGED', '게임 탭 연결이 바뀌거나 닫혔습니다. 게임을 새로고침해 주세요.');
  }
}
async function connectGame(tabId) {
  if (!await chrome.extension.isAllowedFileSchemeAccess()) throw fail('FILE_ACCESS_REQUIRED', '확장 프로그램 세부정보에서 파일 URL에 대한 액세스 허용을 켜 주세요.');
  if (!Number.isInteger(tabId)) {
    const {lastGame} = await chrome.storage.session.get('lastGame');
    if (lastGame) tabId = lastGame.tabId;
    else {
      const tabs = await chrome.tabs.query({url: 'file:///*'});
      for (const tab of tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))) {
        try { const game = await connectGame(tab.id); if (game) return game; } catch {}
      }
      return null;
    }
  }
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return null; }
  if (!tab.url?.startsWith('file:') || !/\.html?$/i.test(new URL(tab.url).pathname)) return null;
  try {
    const target = {tabId, frameIds: [0]};
    const [reader] = await chrome.scripting.executeScript({target, world: 'MAIN', files: ['wml-reader.js']});
    await chrome.scripting.executeScript({target: {tabId, documentIds: [reader.documentId]}, world: 'ISOLATED', files: ['game-bridge.js']});
    const reply = await chrome.tabs.sendMessage(tabId, {type: 'READ_SNAPSHOT', connect: true}, {documentId: reader.documentId});
    if (!reply?.ok) throw fail('SNAPSHOT_UNAVAILABLE', 'WML 활성 모드 목록을 읽지 못했습니다. 게임 로딩이 끝난 뒤 목록을 다시 불러와 주세요.');
    const game = (await chrome.storage.session.get('game-' + tabId))['game-' + tabId];
    if (game?.documentId !== reader.documentId || game.url !== tab.url) throw fail('CONTEXT_CHANGED', '게임 탭이 변경되었습니다. 목록을 다시 불러와 주세요.');
    return await freshGame(tabId);
  } catch (error) {
    if (error.code) throw error;
    throw fail('CONNECTION_FAILED', '열린 게임 탭에 연결하지 못했습니다. 파일 URL 액세스 허용과 게임 로딩 상태를 확인한 뒤 다시 시도하세요.');
  }
}
async function checkMod(message) {
  const game = await freshGame(message.tabId);
  const mod = game?.mods.find(item => item.modId === message.modId);
  if (!mod) throw fail('MOD_INACTIVE', '현재 활성 모드가 아닙니다.');
  if (!mod.supported) throw fail('UNSUPPORTED_VERSION', mod.reason);
  if (!mod.postURL) throw fail('MISSING_POST_URL', '모드의 Kone 게시글 주소를 등록해 주세요.');
  let release;
  try { release = await latest(mod.modId, mod.postURL, true); }
  catch (error) { if (!error.code) error.code = /네트워크|연결|시간|확인 실패/.test(error.message) ? 'NETWORK_ERROR' : 'POST_FORMAT_INVALID'; throw error; }
  if (release.passwordRequired) return {state:'password_required',message:'비밀번호를 입력하면 컬렉션의 모드 버전을 확인합니다.',release};
  const comparison = compareVersions(release.version, mod.modVersion);
  return {state: comparison > 0 ? 'ready' : comparison === 0 ? 'current' : 'older', message: comparison > 0 ? '새 버전을 설치할 수 있습니다.' : comparison === 0 ? '최신 버전입니다.' : '설치된 버전이 더 높습니다.', checkedAt: release.checkedAt, postURL: mod.postURL, source: mod.source, release};
}
async function notifyUpdates(game) {
  let newer = await notifyGameUpdate(game), firstUpdate, checked = false;
  for (const mod of (await decorate(game)).mods) {
    if (!mod.supported || !mod.postURL) continue;
    try {
      const check = await mutate(async () => {
        const key = 'notify-check-' + game.tabId, stored = await chrome.storage.session.get([key, 'game-' + game.tabId]);
        if (stored['game-' + game.tabId]?.documentId !== game.documentId) return false;
        const checks = stored[key] || {}, previous = checks[mod.modId];
        if (previous?.documentId === game.documentId && previous.postURL === mod.postURL && previous.modVersion === mod.modVersion && Date.now() - previous.checkedAt < 60000) return false;
        await chrome.storage.session.set({[key]: {...checks, [mod.modId]: {documentId: game.documentId, postURL: mod.postURL, modVersion: mod.modVersion, checkedAt: Date.now()}}});
        return true;
      });
      if (!check) continue;
      const release = await latest(mod.modId, mod.postURL, true);
      if (release.passwordRequired) continue;
      checked = true;
      const current = (await chrome.storage.session.get('game-' + game.tabId))['game-' + game.tabId];
      if (current?.documentId !== game.documentId) return;
      const active = (await decorate(current)).mods.find(item => item.modId === mod.modId);
      if (!active?.supported || active.modVersion !== mod.modVersion || active.postURL !== mod.postURL) continue;
      if (compareVersions(release.version, mod.modVersion) <= 0) continue;
      newer = true;
      firstUpdate ||= mod.modId;
      await chrome.tabs.sendMessage(game.tabId, {type: 'UPDATE_AVAILABLE', modId: mod.modId, modName: mod.modName, current: mod.modVersion, version: release.version}, {documentId: game.documentId});
    } catch {}
  }
  if (!checked) return;
  await chrome.action.setBadgeText({tabId: game.tabId, text: newer ? 'NEW' : ''});
  if (firstUpdate) {
    const key = 'opened-update-' + game.tabId;
    const open = await mutate(async () => {
      const stored = await chrome.storage.session.get([key, 'game-' + game.tabId]);
      if (stored[key] === game.documentId || stored['game-' + game.tabId]?.documentId !== game.documentId) return false;
      await chrome.storage.session.set({[key]: game.documentId});
      return true;
    });
    if (open) {
      try { await openUI(game.tabId, firstUpdate); }
      catch { await chrome.storage.session.remove(key); }
    }
  }
}
async function notifyHelperUpdate(game) {
  if (!checkHelperUpdate) return;
  const key='helper-check-'+game.tabId;
  const first=await mutate(async () => {
    const stored=await chrome.storage.session.get([key,'game-'+game.tabId]);
    if(stored[key]===game.documentId || stored['game-'+game.tabId]?.documentId!==game.documentId) return false;
    await chrome.storage.session.set({[key]:game.documentId});
    return true;
  });
  if (!first) return;
  await checkHelperUpdate();
  const [{helperUpdateStatus:status},stored]=await Promise.all([chrome.storage.local.get('helperUpdateStatus'),chrome.storage.session.get('game-'+game.tabId)]);
  if(status?.state!=='waiting' || !status.latest || stored['game-'+game.tabId]?.documentId!==game.documentId) return;
  await chrome.tabs.sendMessage(game.tabId,{type:'HELPER_UPDATE_AVAILABLE',current:chrome.runtime.getManifest().version,version:status.latest},{documentId:game.documentId});
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  (async () => {
    const ownUI = sender.url?.split('?')[0] === chrome.runtime.getURL('update.html');
    const gameSender = Number.isInteger(sender.tab?.id) && sender.url?.startsWith('file:') && sender.frameId === 0 && typeof sender.documentId === 'string';
    if (message?.type === 'GAME_SNAPSHOT') {
      if (!gameSender) throw fail('INVALID_SENDER', '게임 탭을 확인할 수 없습니다.');
      const tab = await chrome.tabs.get(sender.tab.id);
      if (tab.url !== sender.url) throw fail('CONTEXT_CHANGED', '게임 탭이 변경되었습니다.');
      const game = await saveSnapshot(message, sender);
      notifyUpdates(game).catch(() => {});
      notifyHelperUpdate(game).catch(() => {});
      return {ok: true};
    }
    if (message?.type === 'OPEN_UPDATER' && gameSender) { await openUI(sender.tab.id, message.modId); return {ok: true}; }
    if (!ownUI) throw fail('INVALID_SENDER', '확장 프로그램 화면에서만 요청할 수 있습니다.');
    if (message?.type === 'CHECK_HELPER_UPDATE') {
      if (!checkHelperUpdate) throw new Error('도우미 업데이트 확인을 사용할 수 없습니다.');
      await checkHelperUpdate(); return {ok:true};
    }
    if(message?.type==='GET_GAME_SOURCE' || message?.type==='CHECK_GAME_RELEASE') {
      const game=await connectGame(message.tabId);
      if(!game || message.documentId && game.documentId!==message.documentId) throw fail('CONTEXT_CHANGED','연결된 게임이 변경되었습니다. 목록을 새로 불러와 주세요.');
      const source=gameSource(game), key='game-edition-'+game.gameFamily;
      if(message.type==='GET_GAME_SOURCE') return {ok:true,source,edition:(await chrome.storage.local.get(key))[key] || source?.packages[0].id};
      if(typeof message.edition!=='string' || !source?.packages.some(item=>item.id===message.edition)) throw new Error('게임 업데이트 배포판을 선택해 주세요.');
      const result=await latestGame(game,true,message.edition);
      await chrome.storage.local.set({[key]:message.edition});
      return {ok:true,...result};
    }
    if (message?.type === 'DIAGNOSE_POST') {
      validateModId(message.modId);
      if (typeof message.postURL !== 'string' || message.postURL.length > 2048) throw fail('POST_URL_INVALID', '게시글 주소가 비었거나 너무 깁니다.');
      return {ok:true,diagnostic:await diagnosePost(message.modId,message.postURL)};
    }
    if (message?.type === 'GET_GAME') return {ok: true, game: await connectGame(message.tabId)};
    if (message?.type === 'GET_SETTINGS') return {ok: true, settings: await settings(), ...await passwordSettings()};
    if (message?.type === 'SET_DEFAULT_PASSWORD') {
      if (typeof message.password !== 'string' || message.password.length > 256) throw fail('INVALID_REQUEST','비밀번호는 256자 이내로 입력하세요.');
      await chrome.storage.local.set({kioDefaultPassword:message.password});
      return {ok:true,...await passwordSettings()};
    }
    if (message?.type === 'SAVE_SETTINGS') {
      const modId = validateModId(message.modId);
      let postURL; try { postURL = validatePostURL(message.postURL); } catch (error) { throw fail('POST_URL_INVALID', error.message); }
      await mutate(async () => { const registrations = await settings(); registrations[modId] = {postURL}; await chrome.storage.local.set({registrations}); await chrome.storage.local.remove('release-' + modId); });
      return {ok: true, settings: await settings()};
    }
    if (message?.type === 'VERIFY_ACTIVE') {
      const modId = validateModId(message.modId);
      if (!Number.isInteger(message.tabId)) throw fail('CONTEXT_CHANGED', '연결된 게임 탭이 없습니다.');
      const game = await freshGame(message.tabId), mod = game?.mods.find(item => item.modId === modId);
      if (!mod) throw fail('MOD_INACTIVE', '이 모드는 현재 꺼져 있습니다. 활성 모드만 업데이트할 수 있습니다.');
      if (!mod.supported) throw fail('UNSUPPORTED_VERSION', mod.reason);
      return {ok: true, status: {...mod, wmlVersion: game.wmlVersion, gameVersion: game.gameVersion, gameFamily: game.gameFamily, url: game.url, documentId: game.documentId}};
    }
    if (message?.type === 'CHECK_RELEASE') { validateModId(message.modId); return {ok: true, release: (await checkMod(message)).release}; }
    if (message?.type === 'CHECK_MOD') {
      try { return {ok: true, check: await checkMod(message)}; }
      catch (error) { return {ok: true, check: {state: ({MISSING_POST_URL: 'missing_url', UNSUPPORTED_VERSION: 'unsupported', MOD_INACTIVE: 'unsupported', KONE_LOGIN_REQUIRED: 'login_required', POST_FORMAT_INVALID: 'invalid_post', POST_URL_INVALID: 'invalid_post'})[error.code] || 'network_error', message: error.message, checkedAt: Date.now()}}; }
    }
    throw new Error('지원하지 않는 요청입니다.');
  })().then(respond, error => respond({ok: false, error: error.message, code: error.code || 'INVALID_REQUEST'}));
  return true;
});
const checkHelperUpdate = startSelfUpdates();

for (const event of [chrome.runtime.onInstalled,chrome.runtime.onStartup]) event?.addListener(() => { void connectGame().then(game => game && notifyUpdates(game)).catch(() => {}); });
if(chrome.alarms?.onAlarm) {
  void chrome.alarms.create('game-update-check',{periodInMinutes:60});
  chrome.alarms.onAlarm.addListener(alarm=>{
    if(alarm.name!=='game-update-check') return;
    void (async()=>{
      const stored=await chrome.storage.session.get(null);
      for(const [key,value] of Object.entries(stored)) {
        if(!key.startsWith('game-') || !Number.isInteger(value?.tabId)) continue;
        const game=await freshGame(value.tabId);
        if(game) await notifyGameUpdate(game,true);
      }
    })().catch(()=>{});
  });
}
