import {compareVersions, validatePostURL} from './core.mjs';
import {inspectGameDirectory, inspectPackage, evaluateCompatibility, applyUpdate, listBackups, restoreBackup, readModMetadata} from './installer.mjs';
import {downloadRelease} from './kio.js';
import {loadGameFolder, saveGameFolder, forgetGameFolder} from './folder-store.mjs';
import {gameFamilyLabel} from './game-compat.mjs';
import {connectNativeGameFolder} from './native-filesystem.mjs';
import {MOD_NAMES_KO} from './mod-names-ko.mjs';
import {holdUpdaterWindow} from './self-update.mjs';
import {initGameUpdater} from './game-update-ui.mjs';
await holdUpdaterWindow();
let gameUpdater;
const $ = id => document.getElementById(id);
let defaultPassword = '', passwordConfigured = false;
let game, release, root, installed, settings = {}, busy = false, approval = null, generation = 0;
let selectedId = '';
let diagnosing = false, diagnosticGeneration = 0;
let backups = [];
let bulkRoot = null;
let rememberedRoot = null;
let namesRoot = null;
let automaticRefreshPending = false, automaticRefreshRunning = false;
const passwords = new Map();
const selectedUpdates = new Set();
const jobs = [];
const nativeRoots = new Set();
function closeUnusedNativeRoots() {
  for (const handle of nativeRoots) {
    if (handle === bulkRoot || handle === root || jobs.some(job => ['waiting','running'].includes(job.state) && job.approved.root === handle)) continue;
    handle.disconnect(); nativeRoots.delete(handle);
  }
}
const checks = new Map();
const modMetadata = new Map();
const searchText = value => String(value).normalize('NFKC').toLocaleLowerCase();
const modLabel = mod => [...new Set([(/[가-힣]/.test(mod?.modNameKo || '') ? mod.modNameKo : MOD_NAMES_KO[mod?.modId]), mod?.modNameKo, mod?.modNameEn, mod?.modName].filter(Boolean))].join(' · ') || mod?.modId || '';
const matchesSearch = (mod, query) => searchText(`${modLabel(mod)} ${mod.modId}`).includes(query);
const gameFile = current => decodeURIComponent(new URL(current.url).pathname.split('/').pop());
const gameDescription = info => `${gameFamilyLabel(info.gameFamily)} · WML ${info.wmlVersion} · HTML ${info.htmlVersion || info.gameVersion}`;
const currentMod = () => game?.mods.find(mod => mod.modId === selectedId);
const sourceURL = mod => mod?.apiPostURL || settings[mod?.modId]?.postURL || mod?.postURL || '';
const sourceLabel = mod => mod?.apiPostURL ? 'API 주소 우선' : sourceURL(mod) ? '수동 등록' : '주소 미등록';
const pendingMod = modId => jobs.some(job => ['waiting','running'].includes(job.state) && job.approved.modId === modId);
function useCachedReleases(mods, preserveCompleted = false) {
  for (const mod of mods) {
    const cached = mod.cachedRelease;
    if (cached && cached.modId === mod.modId && cached.postURL === sourceURL(mod)) {
      const completed = preserveCompleted && jobs.findLast(job => job.state === 'done' && job.documentId === game.documentId && job.approved.tabId === game.tabId && job.approved.modId === mod.modId);
      if (completed && compareVersions(completed.approved.version, cached.version) >= 0) {
        checks.set(mod.modId, {text:`설치 ${completed.approved.version} · 적용 완료, 게임 새로고침 필요`});
        continue;
      }
      const cmp = compareVersions(cached.version, mod.modVersion);
      checks.set(mod.modId, {release:cached,text:`최근 확인 · ${cmp > 0 ? '업데이트 가능' : cmp === 0 ? '최신 상태' : '설치 버전이 더 높음'} · 배포 ${cached.version} (ZIP 내부는 설치 승인 후 검사)`});
    }
  }
}
async function refreshAutomaticUpdates() {
  if (!automaticRefreshPending || automaticRefreshRunning || busy || diagnosing || approval || jobs.some(job => ['waiting','running'].includes(job.state))) return;
  automaticRefreshPending = false; automaticRefreshRunning = true;
  const originalGame = game, token = generation;
  try {
    const fresh = (await message({type:'GET_GAME',tabId:originalGame.tabId})).game;
    if (game !== originalGame || token !== generation) return;
    if (busy || diagnosing || approval || jobs.some(job => ['waiting','running'].includes(job.state))) { automaticRefreshPending = true; return; }
    if (fresh?.tabId !== game.tabId || fresh.url !== game.url) return;
    const sameDocument = fresh.documentId === game.documentId;
    const sameMods = fresh.mods.length === game.mods.length && fresh.mods.every(mod => game.mods.some(current => current.modId === mod.modId && current.modVersion === mod.modVersion && sourceURL(current) === sourceURL(mod)));
    if (!sameDocument || !sameMods) {
      await loadActive();
      if (sameDocument && game) useCachedReleases(game.mods, true);
      showTab('updates'); return;
    }
    useCachedReleases(fresh.mods.filter(mod => game.mods.some(current => current.modId === mod.modId && current.modVersion === mod.modVersion && sourceURL(current) === sourceURL(mod))), true);
    showTab('updates');
  } catch {} finally { automaticRefreshRunning = false; refreshButtons(); }
}
chrome.runtime.onMessage?.addListener((notice, sender) => {
  if (sender.id !== chrome.runtime.id || notice?.type !== 'UPDATES_AVAILABLE' || notice.tabId !== game?.tabId) return;
  automaticRefreshPending = true; void refreshAutomaticUpdates();
});
const readyMods = () => (game?.mods || []).filter(mod => {
  const checked = checks.get(mod.modId);
  return mod.supported !== false && checked?.release && checked.release.postURL === sourceURL(mod) && compareVersions(checked.release.version, mod.modVersion) > 0 && !pendingMod(mod.modId);
});
function showTab(name, focus = false) {
  for (const tab of ['updates','active','settings']) {
    const active = tab === name;
    $(`tab-${tab}`).setAttribute('aria-selected', String(active)); $(`tab-${tab}`).tabIndex = active ? 0 : -1;
    $(`panel-${tab}`).hidden = !active;
  }
  if (focus) $(`tab-${name}`).focus();
}
const tabNames = ['updates','active','settings'];
for (const [index,name] of tabNames.entries()) {
  $(`tab-${name}`).onclick = () => showTab(name);
  $(`tab-${name}`).onkeydown = event => {
    const next = event.key === 'ArrowRight' ? (index + 1) % 3 : event.key === 'ArrowLeft' ? (index + 2) % 3 : event.key === 'Home' ? 0 : event.key === 'End' ? 2 : -1;
    if (next >= 0) { event.preventDefault(); showTab(tabNames[next], true); }
  };
}
function renderModOptions() {
  const query = searchText($('settings-search').value.trim());
  const mods = game?.mods || [], matches = mods.filter(mod => matchesSearch(mod, query));
  const current = currentMod();
  $('mod-select').replaceChildren();
  if (current && !matches.includes(current)) $('mod-select').add(new Option(`현재 선택 · ${modLabel(current)} (${current.modId})`, current.modId));
  for (const mod of matches) $('mod-select').add(new Option(`${modLabel(mod)} (${mod.modId})`, mod.modId));
  if (selectedId) $('mod-select').value = selectedId;
  $('settings-search-status').textContent = query ? matches.length ? `검색 결과 ${matches.length}개 · 목록에서 모드를 선택해 주세요.` : '일치하는 모드가 없습니다. 현재 설정은 유지됩니다.' : `활성 모드 ${mods.length}개`;
}
$('settings-search').oninput = renderModOptions;
async function openMod(modId) { $('settings-search').value = ''; renderModOptions(); $('mod-select').value = modId; await selectMod(); showTab('settings'); }
function renderMods() {
  $('active-mods').replaceChildren();
  const query = searchText($('mod-search').value.trim());
  const visible = (game?.mods || []).filter(mod => matchesSearch(mod, query));
  $('active-count').textContent = `${visible.length} / ${game?.mods?.length || 0}개`;
  for (const mod of visible) {
    const row = document.createElement('li'); row.dataset.modId = mod.modId;
    const title = document.createElement('strong'); title.textContent = `${modLabel(mod)} · ${mod.modVersion || '버전 없음'}`;
    const detail = document.createElement('p');
    detail.textContent = `${mod.modId} · API ${mod.apiError ? '오류' : mod.apiSupported ? '지원' : '미지원'} · ${sourceLabel(mod)} · 수동 주소 ${settings[mod.modId]?.postURL ? '저장됨' : '없음'}`;
    if (mod.apiError) detail.textContent += ` · ${mod.apiError}`;
    if (mod.gameSpec) detail.textContent += ` · ${gameFamilyLabel(mod.gameFamily)} 호환 (${mod.gameSpec})`;
    const status = document.createElement('p'); status.className = 'mod-status';
    status.textContent = mod.supported === false ? `지원 불가: ${mod.reason || '버전 정보를 확인할 수 없습니다.'}` : checks.get(mod.modId)?.text || (sourceURL(mod) ? '미확인' : '주소 미등록');
    const select = document.createElement('button'); select.textContent = '모드 설정'; select.disabled = busy || diagnosing || !!approval;
    select.onclick = () => openMod(mod.modId);
    const checkButton = document.createElement('button'); checkButton.textContent = '상태 확인'; checkButton.disabled = busy || diagnosing || !!approval || mod.supported === false;
    checkButton.onclick = async () => { await openMod(mod.modId); await check(); };
    const rollback = document.createElement('button'); rollback.textContent = '롤백'; rollback.disabled = busy || diagnosing || !!approval;
    rollback.onclick = async () => {
      await openMod(mod.modId);
      if (!root) { error('자동 연결 안내를 확인하거나 경로 변경으로 게임 폴더를 연결해 주세요. 연결하면 이 모드의 업데이트 전 백업이 표시됩니다.'); $('folder').focus(); return; }
      $('rollback').scrollIntoView({block:'nearest'}); $('rollback').focus();
    };
    const content = document.createElement('div'), actions = document.createElement('div'); actions.className = 'mod-actions';
    content.append(title, detail, status); actions.append(select, checkButton, rollback); row.append(content, actions); $('active-mods').append(row);
  }
  if (!visible.length) { const row = document.createElement('li'); row.textContent = query ? '일치하는 모드가 없습니다. 다른 이름이나 ID로 검색해 주세요.' : '게임에서 모드를 활성화한 뒤 목록을 새로고침해 주세요.'; $('active-mods').append(row); }
}
$('mod-search').oninput = renderMods;
function renderReady() {
  const focusedId = document.activeElement?.closest('#ready-mods li')?.dataset.modId;
  const available = readyMods(), locked = busy || diagnosing || !!approval;
  for (const id of selectedUpdates) if (!available.some(mod => mod.modId === id)) selectedUpdates.delete(id);
  $('ready-mods').replaceChildren();
  for (const mod of available) {
    const row = document.createElement('li'); row.dataset.modId = mod.modId;
    const label = document.createElement('label'); label.className = 'checkbox-label';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = selectedUpdates.has(mod.modId); checkbox.disabled = locked;
    checkbox.onchange = () => { checkbox.checked ? selectedUpdates.add(mod.modId) : selectedUpdates.delete(mod.modId); renderReady(); };
    const content = document.createElement('span'), title = document.createElement('strong'), detail = document.createElement('span');
    title.textContent = modLabel(mod); detail.className = 'ready-detail';
    detail.textContent = `${mod.modId} · ${mod.modVersion} → ${checks.get(mod.modId).release.version}`;
    content.append(title,detail); label.append(checkbox, content);
    const button = document.createElement('button'); button.type = 'button'; button.textContent = '설정'; button.disabled = locked; button.onclick = () => openMod(mod.modId);
    row.append(label,button); $('ready-mods').append(row);
  }
  const checkedCount = checks.size, failures = [...checks.values()].filter(item => item.error).length;
  $('ready-status').textContent = busy ? `확인 중 · ${checkedCount} / ${game?.mods?.length || 0}개` : available.length ? `업데이트 가능 ${available.length}개 · 확인 ${checkedCount}개${failures ? ` · 확인 실패 ${failures}개 (활성 모드에서 확인)` : ''}` : checkedCount ? `업데이트 가능한 항목이 없습니다.${failures ? ` 확인 실패 ${failures}개는 활성 모드에서 확인해 주세요.` : ''}` : '‘모두 상태 확인’을 눌러 새 버전이 있는 모드를 찾아보세요.';
  $('select-all-ready').disabled = locked || !available.length;
  $('select-all-ready').checked = available.length > 0 && selectedUpdates.size === available.length;
  $('select-all-ready').indeterminate = selectedUpdates.size > 0 && selectedUpdates.size < available.length;
  $('bulk-selection').textContent = selectedUpdates.size ? `${selectedUpdates.size}개 모드 선택됨` : '업데이트할 모드를 선택해 주세요.';
  $('bulk-folder').disabled = locked || !game?.mods?.length;
  $('bulk-update').disabled = locked || !bulkRoot || !selectedUpdates.size;
  $('bulk-update').textContent = selectedUpdates.size ? `선택한 ${selectedUpdates.size}개 업데이트` : '선택 항목 업데이트';
  if (focusedId) [...$('ready-mods').children].find(row => row.dataset.modId === focusedId)?.querySelector('input')?.focus();
}
$('select-all-ready').onchange = () => {
  if ($('select-all-ready').disabled) return;
  selectedUpdates.clear(); if ($('select-all-ready').checked) for (const mod of readyMods()) selectedUpdates.add(mod.modId);
  renderReady();
};
const message = async data => {
  const result = await chrome.runtime.sendMessage(data);
  if (!result?.ok) throw Object.assign(new Error(result?.error || '확장 프로그램 연결에 실패했습니다.'), {code:result?.code});
  return result;
};
function error(value) { $('error').hidden = !value; $('error').textContent = value || ''; }
function refreshButtons() {
  const locked = busy || diagnosing || !!approval;
  $('change-password').disabled = locked;
  for (const id of ['mod-select', 'post-url', 'password', 'save-source', 'check', 'folder', 'reload']) $(id).disabled = locked || !selectedId;
  $('refresh-active').disabled = locked;
  $('use-detected-folder').disabled = locked || !game || jobs.some(job => ['waiting','running'].includes(job.state));
  $('settings-search').disabled = locked || !game?.mods?.length;
  $('check-all').disabled = locked || !game?.mods?.length;
  $('diagnose').disabled = locked || !selectedId;
  $('diagnostic-retry').disabled = locked || !selectedId;
  $('refresh-backups').disabled = locked || !root || !installed;
  $('post-url').disabled ||= !!currentMod()?.apiPostURL;
  $('save-source').disabled ||= !!currentMod()?.apiPostURL;
  $('folder').disabled ||= currentMod()?.supported === false;
  $('check').disabled ||= currentMod()?.supported === false;
  const pending = jobs.some(job => ['waiting','running'].includes(job.state) && job.approved.modId === selectedId);
  const ready = !!(currentMod()?.supported !== false && root && installed && release && !pending && compareVersions(release.version, installed.modVersion) > 0);
  $('choose-zip').disabled = locked || !ready;
  $('update').disabled = locked || !ready;
  $('reload').disabled ||= jobs.some(job => ['waiting','running'].includes(job.state));
  renderMods();
  renderBackups();
  renderReady();
  gameUpdater?.refresh();
  if (automaticRefreshPending) void refreshAutomaticUpdates();
}
function resetTarget() {
  clearDiagnostic();
  generation++; root = null; installed = null; release = null;
  backups = [];
  $('login-help').hidden = true;
  $('folder-status').textContent = '인식된 게임 경로에 자동 연결합니다. 다른 위치는 경로 변경으로 지정해 주세요.';
  $('mod-compatibility').textContent = '게임 폴더 연결 후 모드 헤더를 확인합니다.';
  $('release-status').textContent = '게시글 주소를 저장한 뒤 새 버전을 확인해 주세요.';
  $('progress').textContent = ''; $('reload').hidden = true; $('manual').hidden = true;
  refreshButtons();
}
function clearDiagnostic() {
  diagnosticGeneration++;
  $('diagnostic').hidden = true;
  $('diagnostic-checks').replaceChildren();
}
const excerpt = value => String(value ?? '—').slice(0, 1200);
function renderDiagnostic(report) {
  const errors = report.checks.filter(item => item.status === 'error').length;
  const blocked = report.checks.some(item => item.status === 'blocked');
  const accessFailure = report.checks.some(item => item.id === 'access' && item.status === 'error');
  $('diagnostic-summary').textContent = errors && !accessFailure ? `수정 필요 ${errors}곳` : blocked ? '진단 중단 · 연결 또는 로그인 확인 필요' : report.ok ? '작성 형식 통과' : '진단 결과 확인 필요';
  const date = new Date(report.checkedAt);
  $('diagnostic-source').textContent = `${report.modId} · ${excerpt(report.postURL)} · 확인 시각 ${Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('ko-KR')}`;
  $('diagnostic-checks').replaceChildren();
  const passes = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = `통과한 항목 ${report.checks.filter(item => item.status === 'pass').length}개 보기`;
  passes.append(summary);
  for (const check of report.checks) {
    const row = document.createElement('article'); row.className = `diagnostic-row diagnostic-${check.status}`;
    const title = document.createElement('h4');
    title.textContent = `${({pass:'통과',error:'수정 필요',blocked:'확인 불가',warning:'안내'})[check.status] || '안내'} · ${excerpt(check.label)}`;
    row.append(title);
    for (const [label, value] of [['위치',check.location],['현재 내용',check.actual],['기대 형식',check.expected],['수정 방법',check.feedback]]) {
      const p = document.createElement('p'); const strong = document.createElement('strong'); strong.textContent = `${label}: `;
      p.append(strong, document.createTextNode(excerpt(value))); row.append(p);
    }
    if (check.example) {
      const label = document.createElement('p'); label.textContent = '복사할 예시';
      const example = document.createElement('textarea'); example.readOnly = true; example.rows = 3;
      example.setAttribute('aria-label', `${excerpt(check.label)} 복사할 예시`); example.value = excerpt(check.example);
      example.onclick = () => example.select(); row.append(label, example);
    }
    (check.status === 'pass' ? passes : $('diagnostic-checks')).append(row);
  }
  if (passes.children.length > 1) $('diagnostic-checks').append(passes);
  $('diagnostic').hidden = false;
}
async function diagnose() {
  if (busy || diagnosing || approval || !selectedId) return;
  clearDiagnostic(); diagnosing = true; error(''); $('login-help').hidden = true; refreshButtons();
  const token = diagnosticGeneration, modId = selectedId;
  const postURL = currentMod()?.apiPostURL || $('post-url').value.trim();
  const current = () => token === diagnosticGeneration && modId === selectedId && postURL === (currentMod()?.apiPostURL || $('post-url').value.trim());
  $('diagnostic').hidden = false; $('diagnostic-summary').textContent = '게시글 작성 형식을 진단하고 있습니다.';
  try {
    const result = await message({type:'DIAGNOSE_POST',modId,postURL});
    if (!current()) return;
    renderDiagnostic(result.diagnostic);
    if (result.diagnostic.checks.some(item => item.id === 'login' && item.status === 'blocked' || ['KONE_LOGIN_REQUIRED','KONE_ACCESS_REQUIRED'].includes(item.code))) {
      $('login-post').href = validatePostURL(postURL); $('login-help').hidden = false;
    }
  } catch (e) {
    if (!current()) return;
    renderDiagnostic({ok:false,modId,postURL,checkedAt:new Date().toISOString(),checks:[{label:'게시글 접근',status:'blocked',location:'게시글 요청',actual:e.message,expected:'읽을 수 있는 Kone 게시글',feedback:['KONE_LOGIN_REQUIRED','KONE_ACCESS_REQUIRED'].includes(e.code) ? '게시글을 열어 로그인한 뒤 다시 진단해 주세요.' : '주소와 네트워크 연결을 확인한 뒤 다시 진단해 주세요.'}]});
    if (['KONE_LOGIN_REQUIRED','KONE_ACCESS_REQUIRED'].includes(e.code)) { $('login-post').href = validatePostURL(postURL); $('login-help').hidden = false; }
  } finally { diagnosing = false; refreshButtons(); }
}
async function selectMod() {
  if (busy || diagnosing || approval) { $('mod-select').value = selectedId; return; }
  selectedId = $('mod-select').value;
  renderModOptions();
  const mod = game?.mods.find(item => item.modId === selectedId);
  $('post-url').value = sourceURL(mod);
  $('source-status').textContent = sourceLabel(mod) + (mod?.apiPostURL ? ' · 모드가 제공한 주소를 사용합니다. 저장된 수동 주소는 예비 주소로 유지됩니다.' : ' · API가 없어도 게시글 주소를 직접 등록할 수 있습니다.');
  $('format-example').textContent = `제목: [${selectedId || 'mod-id'}] 1.2.3\n본문: 다운로드 (1.2.3)\nhttps://kio.ac/c/공유코드\nZIP 이름: ${selectedId || 'mod-id'} 1.2.3.zip`;
  $('password').value = passwords.get(selectedId) ?? defaultPassword;
  $('mod-version').textContent = mod?.modVersion || '—';
  resetTarget(); error('');
  if (checks.has(selectedId)) $('release-status').textContent = checks.get(selectedId).text;
  if (bulkRoot && mod?.supported !== false) {
    busy = true; refreshButtons();
    try { await connectSelectedFolder(); } catch(e) { $('folder-status').textContent = e.message; }
    finally { busy = false; refreshButtons(); }
  }
}
async function inspectMatchingFolder(handle, mod, currentGame, identity) {
  let info;
  if (identity) {
    const {modVersion, gameSpec, supportedWml} = await readModMetadata(handle, mod.modId);
    info = {...identity, modVersion, gameSpec, supportedWml};
  } else info = await inspectGameDirectory(handle, mod.modId, {gameFile:gameFile(currentGame)});
  if (info.wmlVersion !== currentGame.wmlVersion || info.gameVersion !== currentGame.gameVersion || info.gameFamily !== currentGame.gameFamily) throw new Error('선택한 HTML의 게임 계열·빌드·WML 버전이 실행 중인 게임과 다릅니다.');
  const completed = jobs.findLast(job => job.state === 'done' && job.approved.root === handle && job.documentId === currentGame.documentId && job.approved.gameURL === currentGame.url && job.approved.modId === mod.modId);
  if (info.modVersion !== mod.modVersion && completed?.approved.version !== info.modVersion) throw new Error('폴더의 모드 버전과 실행 중인 모드 버전이 다릅니다. 게임 폴더를 확인하고, 업데이트 후라면 게임을 새로고침해 주세요.');
  return info;
}
async function loadModNames(handle, currentGame) {
  if (namesRoot !== handle) { modMetadata.clear(); namesRoot = handle; }
  await Promise.allSettled(currentGame.mods.map(async mod => {
    const key = `${currentGame.url}\n${mod.modId}\n${mod.modVersion}`;
    let metadata = modMetadata.get(key);
    if (!metadata) {
      metadata = await readModMetadata(handle, mod.modId);
      if (metadata.modVersion !== mod.modVersion) return;
      modMetadata.set(key, metadata);
    }
    if (game !== currentGame) return;
    Object.assign(mod, metadata);
  }));
  if (game === currentGame) { renderModOptions(); renderMods(); renderReady(); }
}
async function connectSelectedFolder() {
  const handle = bulkRoot, mod = currentMod(), currentGame = game, token = generation;
  if (!handle || !mod || mod.supported === false) return;
  if (await handle.queryPermission({mode:'readwrite'}) !== 'granted') throw new Error('저장된 폴더 권한이 만료되었습니다. 게임 폴더 선택을 눌러 다시 연결해 주세요.');
  const info = await inspectMatchingFolder(handle, mod, currentGame), foundBackups = await listBackups(handle, mod.modId);
  if (token !== generation || game !== currentGame || selectedId !== mod.modId || approval) return;
  root = handle; installed = info; backups = foundBackups;
  $('folder-status').textContent = `${handle.name}/${info.gameFile} · ${gameDescription(info)} · ${handle.native ? '감지 경로 자동 연결' : '사용자 지정 경로'}`;
  $('html-version').textContent = `${info.htmlVersion} (${info.gameFile})`;
  $('mod-compatibility').textContent = `${gameFamilyLabel(info.gameFamily)} 게임 · 설치 모드 ${info.gameSpec} · 지원 WML ${info.supportedWml?.join(', ') || '미선언'}`;
}
async function rememberFolder(handle, currentGame) {
  if (handle.native) return;
  rememberedRoot = handle;
  try { await saveGameFolder(currentGame.url, handle); } catch {}
}
async function restoreGameFolder() {
  const currentGame = game, token = generation;
  if (!currentGame) return;
  try {
    const stored = await loadGameFolder(currentGame.url).catch(() => null);
    const saved = stored || await connectNativeGameFolder(currentGame.url);
    if (saved.native) nativeRoots.add(saved);
    if (game !== currentGame || token !== generation || approval) return;
    rememberedRoot = saved.native ? null : saved;
    if (!saved) return;
    if (await saved.queryPermission({mode:'readwrite'}) !== 'granted') throw new Error('저장된 폴더 권한이 만료되었습니다. 게임 폴더 선택을 눌러 다시 연결해 주세요.');
    const mod = currentMod()?.supported !== false ? currentMod() : currentGame.mods.find(item => item.supported !== false);
    if (!mod) return;
    const info = await inspectMatchingFolder(saved, mod, currentGame);
    if (game !== currentGame || token !== generation || approval) return;
    bulkRoot = saved; $('bulk-folder-status').textContent = `${saved.name}/${info.gameFile} · ${gameDescription(info)} · ${saved.native ? '감지 경로 자동 연결' : '저장한 사용자 경로 연결'}`;
    await connectSelectedFolder();
    await loadModNames(saved, currentGame);
  } catch(e) {
    if (game === currentGame && token === generation) {
      $('bulk-folder-status').textContent = e.message || '저장된 게임 폴더를 연결하지 못했습니다. 게임 폴더를 다시 선택해 주세요.';
      $('folder-status').textContent = $('bulk-folder-status').textContent;
    }
  } finally { closeUnusedNativeRoots(); }
}
$('use-detected-folder').onclick = async () => {
  if ($('use-detected-folder').disabled) return;
  busy = true; refreshButtons(); error('');
  try {
    await forgetGameFolder(game.url);
    bulkRoot = null; rememberedRoot = null; resetTarget();
    closeUnusedNativeRoots();
    await restoreGameFolder();
  } catch(e) { error(e.message); }
  finally { busy = false; refreshButtons(); }
};
async function inspectPost(mod, postURL) {
  if (!postURL) throw Object.assign(new Error('게시글 주소를 먼저 등록해 주세요.'), {code:'MISSING_URL'});
  validatePostURL(postURL);
  const result = (await message({type:'CHECK_RELEASE',modId:mod.modId,tabId:game.tabId,...(passwords.has(mod.modId) ? {password:passwords.get(mod.modId)} : {})})).release;
  if (result.passwordRequired) throw Object.assign(new Error('기본 비밀번호를 설정하거나 모드별 비밀번호를 확인한 뒤 다시 시도하세요.'), {code:'PASSWORD_REQUIRED'});
  if (result.modId !== mod.modId || result.postURL !== postURL) throw new Error('확인한 출처가 변경되었습니다. 활성 목록을 다시 불러와 주세요.');
  const cmp = compareVersions(result.version, mod.modVersion);
  checks.set(mod.modId, {release:result,text:`파일명 확인 완료 · ${cmp > 0 ? '업데이트 가능' : cmp === 0 ? '최신 상태' : '설치 버전이 더 높음 · 다운그레이드 안 함'} · 배포 ${result.version} (ZIP 내부는 설치 승인 후 검사)`});
  return result;
}
function recordCheckError(modId, e) {
  const label = ({PASSWORD_REQUIRED:'비밀번호 필요',MISSING_URL:'주소 미등록',MISSING_POST_URL:'주소 미등록',KONE_LOGIN_REQUIRED:'로그인 필요',KONE_ACCESS_REQUIRED:'접근 권한 필요',POST_FORMAT_INVALID:'게시글 형식 오류',POST_URL_INVALID:'주소 오류',NETWORK:'네트워크 오류',NETWORK_ERROR:'네트워크 오류',MOD_INACTIVE:'비활성 모드',UNSUPPORTED_VERSION:'지원 불가'})[e.code] || '게시글 확인 오류';
  checks.set(modId, {error:true,text:`${label}: ${e.message}`});
}
async function check() {
  if (busy || diagnosing || approval || !selectedId) return;
  busy = true; release = null; error(''); $('login-help').hidden = true; refreshButtons();
  const token = generation, modId = selectedId, postURL = $('post-url').value.trim();
  $('release-status').textContent = '배포 게시글을 확인하고 있습니다.';
  try {
    if (!postURL) throw Object.assign(new Error('게시글 주소를 먼저 등록해 주세요.'), {code:'MISSING_URL'});
    validatePostURL(postURL);
    if (!currentMod()?.apiPostURL) { await message({type:'SAVE_SETTINGS', modId, postURL}); settings[modId] = {postURL}; }
    let result;
    try { result = await inspectPost(currentMod(), postURL); }
    catch (e) { if (e.code !== 'PASSWORD_REQUIRED' || passwords.has(modId) || !await askPassword(true)) throw e; result = await inspectPost(currentMod(), postURL); }
    if (token !== generation || modId !== selectedId) return;
    if (result.modId !== modId || result.postURL !== postURL) throw new Error('확인한 배포 정보의 모드 또는 출처가 다릅니다. 다시 확인해 주세요.');
    release = result;
    $('release-status').textContent = checks.get(modId).text;
  } catch (e) {
    recordCheckError(modId,e); release = null; $('release-status').textContent = checks.get(modId).text; error(e.message);
    if (['KONE_LOGIN_REQUIRED','KONE_ACCESS_REQUIRED'].includes(e.code)) { $('login-post').href = validatePostURL(postURL); $('login-help').hidden = false; }
  }
  finally { busy = false; refreshButtons(); }
}
$('mod-select').onchange = selectMod;
async function askPassword(force = false) {
  if (passwordConfigured && !force) return true;
  const dialog = $('password-dialog');
  $('default-password').value = passwordConfigured ? defaultPassword : 'somisoft';
  dialog.returnValue = 'cancel';
  const choice = new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue), {once:true}));
  dialog.showModal(); $('default-password').focus();
  if (await choice !== 'save') return false;
  const value = $('default-password').value;
  await message({type:'SET_DEFAULT_PASSWORD',password:value});
  defaultPassword = value; passwordConfigured = true;
  if (!passwords.has(selectedId)) $('password').value = value;
  return true;
}
$('change-password').onclick = async () => {
  if (busy || diagnosing || approval) return;
  busy=true; refreshButtons();
  try { if (await askPassword(true)) $('progress').textContent='기본 비밀번호를 저장했습니다. 다음 업데이트부터 사용합니다.'; }
  catch(e) { error(e.message); }
  finally { busy=false; refreshButtons(); }
};
$('password').oninput = () => { if (!busy && !approval && !diagnosing && selectedId) passwords.set(selectedId, $('password').value); };
$('post-url').oninput = () => { clearDiagnostic(); if (busy || approval) return; checks.delete(selectedId); resetTarget(); };
$('save-source').onclick = async () => {
  if (busy || diagnosing || approval || !selectedId) return;
  resetTarget(); busy = true; error(''); refreshButtons();
  try {
    const postURL = $('post-url').value.trim(); validatePostURL(postURL);
    await message({type:'SAVE_SETTINGS',modId:selectedId,postURL}); settings[selectedId] = {postURL};
    checks.delete(selectedId); $('source-status').textContent = sourceLabel(currentMod());
    $('release-status').textContent = '게시글 주소를 저장했습니다. 새 버전을 확인해 주세요.';
  } catch(e) { error(e.message); }
  finally { busy = false; refreshButtons(); }
};
$('check').onclick = check;
$('diagnose').onclick = diagnose;
$('diagnostic-retry').onclick = diagnose;
$('check-all').onclick = async () => {
  if (busy || diagnosing || approval) return;
  busy = true; release = null; refreshButtons(); error('');
  try {
    for (const mod of game?.mods || []) {
      if (mod.supported === false) continue;
      try { const result = await inspectPost(mod, sourceURL(mod)); if (mod.modId === selectedId) release = result; } catch(e) { recordCheckError(mod.modId,e); }
      renderMods(); renderReady();
    }
    $('release-status').textContent = checks.get(selectedId)?.text || '확인을 마쳤습니다.';
  } finally { busy = false; refreshButtons(); }
};
$('folder').onclick = async () => {
  if (busy || diagnosing || approval || !selectedId) return;
  busy = true; error(''); refreshButtons();
  const token = ++generation, modId = selectedId, currentGame = game;
  try {
    if (!window.showDirectoryPicker) throw new Error('최신 Chrome 또는 Edge에서 게임 폴더를 선택해 주세요.');
    const selected = await window.showDirectoryPicker({mode:'readwrite',id:'wml-game',...(rememberedRoot ? {startIn:rememberedRoot} : {})});
    const info = await inspectMatchingFolder(selected, currentMod(), currentGame);
    if (token !== generation || modId !== selectedId) return;
    root = selected; installed = info;
    bulkRoot = selected; $('bulk-folder-status').textContent = `${selected.name}/${info.gameFile} · ${gameDescription(info)} · 사용자 지정 경로`;
    backups = await listBackups(root, modId);
    $('folder-status').textContent = $('bulk-folder-status').textContent;
    $('html-version').textContent = `${info.htmlVersion} (${info.gameFile})`;
    $('mod-compatibility').textContent = `설치 모드 ${info.gameSpec} · 지원 WML ${info.supportedWml?.join(', ') || '미선언'}`;
    await rememberFolder(selected, currentGame);
    await loadModNames(selected, currentGame);
    closeUnusedNativeRoots();
  } catch(e) { if (e.name !== 'AbortError') error(e.message); }
  finally { busy = false; refreshButtons(); }
};
$('bulk-folder').onclick = async () => {
  if ($('bulk-folder').disabled) return;
  busy = true; error(''); refreshButtons();
  const token = ++generation, currentGame = game;
  try {
    if (!window.showDirectoryPicker) throw new Error('최신 Chrome 또는 Edge에서 게임 폴더를 선택해 주세요.');
    const chosen = await window.showDirectoryPicker({mode:'readwrite',id:'wml-game',...(rememberedRoot ? {startIn:rememberedRoot} : {})});
    const mod = readyMods().find(item => selectedUpdates.has(item.modId)) || game.mods.find(item => item.supported !== false);
    if (!mod) throw new Error('지원 가능한 활성 모드가 없습니다.');
    const info = await inspectMatchingFolder(chosen, mod, currentGame);
    if (token !== generation || game !== currentGame || approval) return;
    bulkRoot = chosen; $('bulk-folder-status').textContent = `${chosen.name}/${info.gameFile} · ${gameDescription(info)} · 사용자 지정 경로`;
    await rememberFolder(chosen, currentGame);
    await connectSelectedFolder();
    await loadModNames(chosen, currentGame);
    closeUnusedNativeRoots();
  } catch(e) { if (e.name !== 'AbortError') error(e.message); }
  finally { busy = false; refreshButtons(); }
};
$('bulk-update').onclick = async () => {
  if ($('bulk-update').disabled) return;
  const targetRoot = bulkRoot, mods = readyMods().filter(mod => selectedUpdates.has(mod.modId));
  if (!mods.length) return;
  busy = true; error(''); refreshButtons();
  try {
    if (!await askPassword()) return;
    const items = [];
    let identity;
    for (const mod of mods) {
      const found = checks.get(mod.modId)?.release;
      if (!found || found.postURL !== sourceURL(mod) || pendingMod(mod.modId)) throw new Error(`${mod.modId}: 업데이트 정보가 달라졌습니다. 다시 확인해 주세요.`);
      const active = (await message({type:'VERIFY_ACTIVE',tabId:game.tabId,modId:mod.modId})).status;
      const info = await inspectMatchingFolder(targetRoot,mod,game,identity);
      identity = info;
      if (!active?.active || active.modId !== mod.modId || active.modVersion !== mod.modVersion || active.wmlVersion !== info.wmlVersion || active.gameVersion !== info.gameVersion || info.wmlVersion !== game.wmlVersion || info.gameVersion !== game.gameVersion) throw new Error(`${mod.modId}: 실행 중인 모드와 선택한 폴더의 버전이 다릅니다. 폴더 모드를 사용하고 게임을 새로고침해 주세요.`);
      if (compareVersions(found.version, info.modVersion) <= 0) throw new Error(`${mod.modId}: 새 버전만 적용할 수 있습니다.`);
      if (active.url !== game.url || active.documentId !== game.documentId) throw new Error('실행 중인 게임 문서가 바뀌었습니다. 목록을 새로고침해 주세요.');
      items.push(Object.freeze({root:targetRoot,modId:mod.modId,version:found.version,fileName:found.fileName,url:found.url,postURL:found.postURL,installed:info.modVersion,runtimeVersion:mod.modVersion,wmlVersion:info.wmlVersion,gameVersion:info.gameVersion,gameFamily:info.gameFamily,gameFile:info.gameFile,gameURL:game.url,documentId:game.documentId,password:passwords.get(mod.modId) ?? defaultPassword,bytes:null,tabId:game.tabId}));
    }
    approval = Object.freeze({kind:'bulk',items:Object.freeze(items)});
    $('confirm-description').textContent = `선택한 ${items.length}개 모드 업데이트\n\n` + items.map(item => `${item.modId}\n버전: ${item.installed} → ${item.version}\n게임: ${gameDescription(item)} (${item.gameFile})\n출처: ${item.postURL}\n다운로드: ${item.url}\n대상: ${item.root.name}/wml/mods/${item.modId}`).join('\n\n');
    $('confirm').returnValue = 'cancel'; $('confirm').showModal();
  } catch(e) { error(e.message); }
  finally { busy = false; refreshButtons(); }
};
function askApproval(bytes = null, fileName = '') {
  approval = Object.freeze({root,modId:selectedId,version:release.version,fileName:release.fileName,url:release.url,postURL:release.postURL,installed:installed.modVersion,runtimeVersion:currentMod()?.modVersion,wmlVersion:installed.wmlVersion,gameVersion:installed.gameVersion,gameFamily:installed.gameFamily,gameFile:installed.gameFile,gameURL:game.url,documentId:game.documentId,password:$('password').value,bytes,tabId:game?.tabId});
  $('confirm-description').textContent = `모드: ${approval.modId}\n게임: ${gameDescription(approval)} (${approval.gameFile})\n출처: ${approval.postURL}\n다운로드: ${approval.url}\n대상: ${root.name}/wml/mods/${approval.modId}\n버전: ${approval.installed} → ${approval.version}${fileName ? `\n선택한 ZIP: ${fileName}` : ''}`;
  refreshButtons(); $('confirm').returnValue = 'cancel'; $('confirm').showModal();
}
$('update').onclick = async () => {
  if ($('update').disabled) return;
  busy = true; refreshButtons();
  try { if (await askPassword()) askApproval(); } catch(e) { error(e.message); }
  finally { busy = false; refreshButtons(); }
};
$('choose-zip').onclick = () => { if (!$('choose-zip').disabled) $('zip-file').click(); };
$('zip-file').onchange = async () => {
  if (busy || diagnosing || approval) return;
  const token = generation;
  busy = true; refreshButtons();
  try {
    const file = $('zip-file').files[0]; if (!file) return;
    if (file.size > 256 * 1024 * 1024) throw new Error('모드 ZIP은 최대 256 MiB입니다.');
    const bytes = await file.arrayBuffer();
    if (token !== generation || !root || !installed || !release || compareVersions(release.version, installed.modVersion) <= 0) throw new Error('새 버전과 적용할 폴더를 먼저 확인해 주세요.');
    askApproval(bytes, file.name);
  } catch(e) { error(e.message); }
  finally { busy = false; $('zip-file').value = ''; refreshButtons(); }
};
function renderJobs() {
  $('queue').hidden = jobs.length === 0; $('queue-list').replaceChildren();
  for (const job of jobs) {
    const item = document.createElement('li'); item.dataset.state = job.state;
    const text = document.createElement('p');
    text.textContent = `${job.approved.modId} ${job.approved.version} · ${job.approved.root.name} · ${job.status}`;
    item.append(text);
    if (job.state === 'waiting') { const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '대기 취소'; cancel.onclick = () => job.controller.abort(); item.append(cancel); }
    $('queue-list').append(item);
  }
  refreshButtons();
}
function renderBackups() {
  $('rollback').hidden = !root || !installed;
  $('backup-list').replaceChildren();
  $('backup-status').textContent = backups.length ? `${modLabel(currentMod())} · 현재 설치 ${installed?.modVersion} · 업데이트 전 백업 ${backups.length}개` : '이 모드의 업데이트 전 백업이 없습니다. 도우미로 업데이트하면 자동으로 생성됩니다.';
  for (const backup of backups) {
    const row = document.createElement('li'), description = document.createElement('p'), button = document.createElement('button');
    const matchesInstalled = backup.version === installed?.modVersion;
    const compatibility = evaluateCompatibility(backup, installed.wmlVersion, installed.gameVersion);
    const incompatible = compatibility.gameState === 'unsupported' || compatibility.state === 'unsupported';
    description.textContent = `${backup.previousVersion} 복원 · ${backup.gameSpec || '게임 선언 없음'} · ${backup.createdAt || backup.backupPath}${incompatible ? ' · 현재 게임과 호환되지 않음' : ' · 백업 검증 완료'}${matchesInstalled ? '' : ` · ${backup.version} 설치 상태에서만 복원 가능 (현재 ${installed?.modVersion})`}`;
    button.type = 'button'; button.textContent = '이 버전으로 되돌리기';
    button.disabled = incompatible || !matchesInstalled || busy || diagnosing || !!approval || jobs.some(job => ['waiting','running'].includes(job.state) && job.approved.modId === selectedId);
    button.onclick = () => {
      if (button.disabled) return;
      const allowUnknownWml = compatibility.state === 'unknown' && confirm(`${selectedId} ${backup.previousVersion}\n백업 모드에 지원 WML 선언이 없습니다. 현재 WML ${installed.wmlVersion}에서의 호환성이 미확인인 상태로 롤백을 계속할까요?`);
      if (compatibility.state === 'unknown' && !allowUnknownWml) return;
      const approved = Object.freeze({kind:'restore',root,modId:selectedId,version:backup.previousVersion,backupPath:backup.backupPath,installed:installed.modVersion,runtimeVersion:currentMod()?.modVersion,wmlVersion:installed.wmlVersion,gameVersion:installed.gameVersion,gameFamily:installed.gameFamily,gameFile:installed.gameFile,gameURL:game.url,documentId:game.documentId,allowUnknownWml,tabId:game?.tabId});
      if (!confirm(`${approved.modId}을 ${approved.installed} → ${approved.version} 버전으로 되돌릴까요?\n백업: ${approved.backupPath}\n게임을 먼저 저장해 주세요. 현재 파일을 별도 백업한 뒤 복원합니다. 완료 후 게임을 새로고침해 주세요.`)) return;
      const job = {approved,controller:new AbortController(),state:'waiting',status:'백업 복원 대기 중'};
      jobs.push(job); error(''); renderJobs(); void runJob(job);
    };
    row.append(description, button); $('backup-list').append(row);
  }
  for (const backup of backups.rejected || []) {
    const row = document.createElement('li'), description = document.createElement('p');
    description.textContent = `복원 불가 · ${excerpt(backup.backupPath)} · ${excerpt(backup.reason)}`;
    row.append(description); $('backup-list').append(row);
  }
}
$('refresh-backups').onclick = async () => {
  if ($('refresh-backups').disabled) return;
  busy = true; refreshButtons();
  try { backups = await listBackups(root, selectedId); } catch(e) { error(e.message); }
  finally { busy = false; refreshButtons(); }
};
async function runJob(job) {
  job.documentId = game?.documentId;
  const approved = job.approved;
  const status = value => { job.status = value; renderJobs(); };
  const verifyActive = async () => {
    const active = (await message({type:'VERIFY_ACTIVE',tabId:approved.tabId,modId:approved.modId})).status;
    if (!active?.active || active.modId !== approved.modId || ![approved.installed, approved.runtimeVersion].includes(active.modVersion) || active.wmlVersion !== approved.wmlVersion || active.gameVersion !== approved.gameVersion || active.gameFamily !== approved.gameFamily || active.url !== approved.gameURL || active.documentId !== approved.documentId) throw new Error('실행 중인 게임 문서 또는 활성 모드 정보가 승인할 때와 다릅니다. 게임과 모드를 다시 확인해 주세요.');
  };
  try {
    if (!navigator.locks) throw new Error('이 브라우저에서는 동시 업데이트 보호 기능을 사용할 수 없습니다.');
    await navigator.locks.request('wml-mod-updater-install', {signal:job.controller.signal}, async () => {
      job.state = 'running'; status('폴더와 버전을 다시 확인하고 있습니다.');
      await verifyActive();
      if (approved.kind !== 'restore' && compareVersions(approved.version, approved.installed) <= 0) throw new Error('새 버전만 적용할 수 있습니다.');
      if (await approved.root.queryPermission({mode:'readwrite'}) !== 'granted') throw new Error('게임 폴더 쓰기 권한이 만료되었습니다. 폴더를 다시 선택해 주세요.');
      const current = await inspectGameDirectory(approved.root, approved.modId, {gameFile:approved.gameFile});
      if (current.wmlVersion !== approved.wmlVersion || current.gameVersion !== approved.gameVersion || current.gameFamily !== approved.gameFamily || current.gameFile !== approved.gameFile) throw new Error('선택한 HTML의 게임 계열·빌드 또는 WML 버전이 변경되었습니다. 경로를 다시 확인해 주세요.');
      if (current.modVersion !== approved.installed) throw new Error('확인 후 설치된 버전이 달라졌습니다. 폴더를 다시 선택해 주세요.');
      let result;
      if (approved.kind === 'restore') {
        await verifyActive(); status('현재 파일 백업 및 선택한 백업 복원 중입니다…');
        result = await restoreBackup(approved.root, approved.backupPath, {modId:approved.modId,expectedInstalledVersion:approved.installed,gameFile:approved.gameFile,allowUnknownWml:approved.allowUnknownWml});
      } else {
        status('승인한 모드 ZIP을 내려받고 있습니다…');
        const bytes = approved.bytes || await downloadRelease({modId:approved.modId,url:approved.url,version:approved.version,fileName:approved.fileName,password:approved.password});
        const pkg = await inspectPackage(bytes, approved.version, approved.modId);
        const compatibility = evaluateCompatibility(pkg, current.wmlVersion, current.gameVersion);
        $('mod-compatibility').textContent = `ZIP: ${gameFamilyLabel(pkg.gameFamily)} · ${pkg.gameSpec} · 지원 WML ${pkg.supportedWml?.join(', ') || '미선언'}`;
        if (compatibility.gameState === 'unsupported') throw new Error(`게임 호환 불가: 현재 ${gameFamilyLabel(current.gameFamily)} ${current.gameVersion} · 모드 선언 ${pkg.gameSpec}. 파일을 변경하지 않았습니다.`);
        if (compatibility.state === 'unsupported') throw new Error(`WML 호환 불가: 현재 ${compatibility.currentWml} · 코드에서 선언한 지원 버전 ${compatibility.supportedWml.join(', ')}. 파일을 변경하지 않았습니다.`);
        const allowUnknownWml = compatibility.state === 'unknown' && confirm(`${approved.modId} ${approved.version}\n코드에 지원 WML 선언 없음 · 호환성 미확인\n현재 WML ${current.wmlVersion}에서 실행 가능한지 확인하지 못했습니다. 그래도 설치할까요?`);
        if (compatibility.state === 'unknown' && !allowUnknownWml) { job.state = 'cancelled'; status('호환성 미확인 설치를 취소했습니다. 파일을 변경하지 않았습니다.'); return; }
        await verifyActive();
        status('ZIP 검사 및 백업 후 적용 중입니다…');
        result = await applyUpdate(approved.root, bytes, {modId:approved.modId,expectedVersion:approved.version,expectedInstalledVersion:approved.installed,allowUnknownWml,gameFile:approved.gameFile});
      }
      const info = await inspectGameDirectory(approved.root, approved.modId, {gameFile:approved.gameFile});
      if (root === approved.root && selectedId === approved.modId) {
        installed = info; $('folder-status').textContent = `${approved.root.name} · ${approved.modId} ${info.modVersion}`; $('manual').hidden = true;
        backups = await listBackups(root, selectedId);
        $('mod-compatibility').textContent = `설치 모드 ${info.gameSpec} · 지원 WML ${info.supportedWml?.join(', ') || '미선언'}`;
      }
      job.state = 'done'; status(`${approved.kind === 'restore' ? '롤백' : '적용'} 완료. 백업: ${result.backupPath}`);
      checks.set(approved.modId, {text:`설치 ${info.modVersion} · 적용 완료, 게임 새로고침 필요`});
      selectedUpdates.delete(approved.modId);
      $('progress').textContent = '게임을 저장한 뒤 모든 업데이트가 끝나면 새로고침해 주세요.';
      $('reload').hidden = !approved.tabId;
    });
  } catch(e) {
    job.state = e.name === 'AbortError' ? 'cancelled' : 'failed';
    status(job.state === 'cancelled' ? '대기를 취소했습니다.' : `실패: ${e.message}`);
    if (job.state === 'failed' && root === approved.root && selectedId === approved.modId) { error(e.message); $('manual').hidden = false; }
  } finally { renderJobs(); closeUnusedNativeRoots(); }
}
$('confirm').addEventListener('close', () => {
  const approved = approval; approval = null;
  if ($('confirm').returnValue !== 'update' || busy || !approved) { refreshButtons(); return; }
  const accepted = (approved.kind === 'bulk' ? approved.items : [approved]).filter(item => !pendingMod(item.modId));
  const queued = accepted.map(item => ({approved:item,controller:new AbortController(),state:'waiting',status:'업데이트 대기 중'}));
  jobs.push(...queued); error(''); renderJobs(); for (const job of queued) void runJob(job);
});
$('reload').onclick = async () => {
  if ($('reload').disabled || busy || diagnosing || approval || !game?.tabId || !confirm('저장하지 않은 진행은 사라질 수 있습니다. 게임을 새로고침할까요?')) return;
  try { await chrome.tabs.reload(game.tabId); } catch(e) { error(e.message); }
};
async function loadActive() {
  if (busy || diagnosing || approval) return;
  const previous = selectedId;
  bulkRoot = null; rememberedRoot = null; selectedUpdates.clear(); $('detected-folder').textContent = ''; $('bulk-folder-status').textContent = '게임 폴더를 확인하고 있습니다.';
  for (const id of ['game-family','html-version','game-version','wml-version']) $(id).textContent = '—';
  busy = true; resetTarget(); checks.clear(); error('');
  closeUnusedNativeRoots();
  try {
  $('access').hidden = await chrome.extension.isAllowedFileSchemeAccess();
  const saved = await message({type:'GET_SETTINGS'});
  settings = saved.settings || {}; passwordConfigured = saved.passwordConfigured === true; defaultPassword = saved.defaultPassword ?? '';
  const params = new URL(location.href).searchParams;
  const tabId = game?.tabId ?? params.get('tabId');
  game = (await message({type:'GET_GAME',...(tabId !== null && /^\d+$/.test(tabId) ? {tabId:Number(tabId)} : {})})).game;
  $('mod-select').replaceChildren(); selectedId = '';
  if(game) {
    $('game-path').textContent = decodeURIComponent(game.url);
    const folderURL = new URL('.', game.url);
    $('detected-folder').textContent = `감지한 게임 폴더: ${folderURL.hostname ? '//' + folderURL.hostname : ''}${decodeURIComponent(folderURL.pathname).replace(/^\/(?=[A-Za-z]:\/)/, '')}`;
    $('bulk-folder-status').textContent = '인식된 게임 경로에 자동 연결하고 있습니다.';
    $('game-version').textContent = game.gameVersion; $('wml-version').textContent = game.wmlVersion;
    $('game-family').textContent = gameFamilyLabel(game.gameFamily);
    $('html-version').textContent = game.htmlVersion || '디스크의 실행 HTML 확인 중';
  }
  if (game?.mods?.length) {
    useCachedReleases(game.mods);
    $('settings-search').value = ''; renderModOptions();
    $('game-status').textContent = `${gameFamilyLabel(game.gameFamily)} · 현재 활성 모드 ${game.mods.length}개 · API 없이도 수동 주소를 등록할 수 있습니다.`;
    const preferred = previous || params.get('modId');
    if (game.mods.some(mod => mod.modId === preferred)) $('mod-select').value = preferred;
    busy = false;
    await selectMod();
    busy = true; refreshButtons();
    await restoreGameFolder();
  } else { $('post-url').value = ''; $('mod-version').textContent = '—'; $('source-status').textContent = ''; $('game-status').textContent = game ? '활성 모드가 없습니다. 게임 본체 업데이트는 아래에서 확인할 수 있습니다.' : 'WML 게임을 열고 활성 목록을 새로고침해 주세요.'; }
  } catch(e) { game = null; selectedId = ''; $('mod-select').replaceChildren(); $('game-status').textContent = '게임 연결을 확인하지 못했습니다.'; error(e.message); }
  finally { busy = false; renderModOptions(); refreshButtons(); }
  await gameUpdater.load(game);
}
$('refresh-active').onclick = loadActive;
showTab(new URL(location.href).searchParams.get('view') === 'settings' ? 'settings' : 'updates');
gameUpdater=initGameUpdater({message,askPassword,getPassword:()=>defaultPassword,isBusy:()=>busy || diagnosing || !!approval || jobs.some(job=>['waiting','running'].includes(job.state)),setBusy:value=>{busy=value;refreshButtons();},onInstalled:()=>{checks.clear();resetTarget();$('game-status').textContent='게임 본체 설치 완료. 게임을 다시 연 뒤 활성 목록을 새로고침하세요.';}});
await loadActive();
