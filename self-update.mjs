const LOCK = 'wml-mod-updater-self-update';
const STATUS = 'helperUpdateStatus';
const REOPEN = 'helperUpdateReopen';
const UPLOAD_CHUNK = 196608;
function base64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(binary);
}
// upload: ZIP bytes streamed to the native host on the same connection before the final request (id 1).
export function nativeUpdate(op, values = {}, keepOpen = false, upload = null) {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connectNative('org.wml.mod_updater');
    let settled = false;
    const timer = setTimeout(() => { port.disconnect(); reject(new Error('업데이트 응답 시간이 초과되었습니다.')); }, op === 'self-apply' ? 900000 : 120000);
    port.onDisconnect.addListener(() => { clearTimeout(timer); if (!settled) reject(new Error(chrome.runtime.lastError?.message || '설치 도우미 연결 종료')); });
    port.onMessage.addListener(message => {
      if (message?.id !== 1) {
        if (message && !message.ok && !settled) { settled = true; clearTimeout(timer); port.disconnect(); reject(new Error(message.error || '업데이트 파일 전달 실패')); }
        return;
      }
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!keepOpen || !message.ok) port.disconnect();
      if (message.ok) resolve({result:message.result,port});
      else reject(new Error(message.error || '도우미 업데이트 실패'));
    });
    if (upload) {
      let id = 2;
      for (let offset = 0; offset < upload.length; offset += UPLOAD_CHUNK) port.postMessage({id:id++, op:'self-upload', offset, total:upload.length, data:base64(upload.subarray(offset, offset + UPLOAD_CHUNK))});
    }
    port.postMessage({id:1,op,...values});
  });
}
export async function reopenUpdaterWindow() {
  const pending = (await chrome.storage.local.get(REOPEN))[REOPEN];
  if (!pending) return;
  if (pending.fromVersion === chrome.runtime.getManifest().version) return;
  await chrome.storage.local.remove(REOPEN);
  const base = chrome.runtime.getURL('update.html');
  if (typeof pending.url !== 'string' || !(pending.url === base || pending.url.startsWith(base + '?'))) return;
  try { await chrome.tabs.update(pending.tabId, {url:pending.url}); }
  catch { await chrome.tabs.create({url:pending.url}); }
}
const RECHECK = ['waiting','login_required','password_required','error'];
const NOT_FOUND = async () => { throw new Error('도우미 배포 게시글을 확인할 수 없습니다.'); };
// findRelease reads the Kone release post and returns {version, postURL, zip, envelope}.
export function startSelfUpdates({findRelease = NOT_FOUND} = {}) {
  if (!chrome.alarms || !chrome.runtime.getManifest) return;
  let active = null, pendingForce = false;
  void reopenUpdaterWindow().catch(() => {});
  const save = result => chrome.storage.local.set({[STATUS]:{...result,checkedAt:Date.now()}});
  async function check(force) {
    try {
      await nativeUpdate('self-confirm',{version:chrome.runtime.getManifest().version});
      const previous=(await chrome.storage.local.get(STATUS))[STATUS];
      if (!force && previous && Date.now()-previous.checkedAt < 21600000 && !RECHECK.includes(previous.state)) return;
      let release;
      try { release = await findRelease(); }
      catch (error) {
        const version = chrome.runtime.getManifest().version;
        if (['KONE_LOGIN_REQUIRED','KONE_ACCESS_REQUIRED'].includes(error.code)) return await save({state:'login_required',version,postURL:error.postURL,message:error.message});
        if (error.code === 'HELPER_UNCONFIGURED') return await save({state:'unconfigured',version});
        if (error.code === 'PASSWORD_REQUIRED') return await save({state:'password_required',version,postURL:error.postURL,message:error.message});
        throw error;
      }
      let {result} = await nativeUpdate('self-check',{envelope:release.envelope});
      if (result.state === 'current' && previous?.state === 'updated' && previous.version === result.version) result=previous;
      if (result.state === 'available') result={...result,state:'waiting',release:{postURL:release.postURL,...release.zip,envelope:release.envelope}};
      await save(result);
    } catch (error) {
      await save(error.message.includes('SELF_RESTART') ? {state:'restart'} : {state:'error',message:error.message});
    }
  }
  function run(force = false) {
    if (active) { pendingForce ||= force; return active; }
    active = (async () => {
      do { pendingForce = false; await check(force); force = pendingForce; } while (force);
    })().finally(() => { active = null; });
    return active;
  }
  chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name.startsWith('helper-update-')) void run(true); });
  chrome.runtime.onStartup.addListener(() => void run(true));
  chrome.runtime.onInstalled.addListener(() => void run(true));
  void chrome.alarms.get('helper-update-check').then(alarm => {
    if (!alarm) return chrome.alarms.create('helper-update-check',{periodInMinutes:360});
  });
  void run();
  return () => run(true);
}
const NO_DOWNLOAD = async () => { throw new Error('도우미 업데이트 파일을 내려받을 수 없습니다.'); };
// download({url,fileName,size}) returns the release ZIP as bytes from the Kio collection.
export async function holdUpdaterWindow({download = NO_DOWNLOAD} = {}) {
  if (!chrome.runtime.getManifest || !chrome.runtime.connectNative || !navigator.locks) return;
  const labels={current:'최신 상태',unconfigured:'자동 업데이트: 배포 저장소 준비 중',waiting:'새 버전이 있습니다',updated:'업데이트 완료',blocked:'이전 버전으로 복구됨',restart:'도우미를 다시 열어 주세요',error:'자동 업데이트 연결 확인 필요',login_required:'코네 로그인 필요 · 배포 게시글에 로그인한 뒤 ‘도우미 업데이트 확인’을 눌러 주세요',password_required:'Kio 기본 비밀번호 설정 필요 · 모드 업데이트용 비밀번호를 저장해 주세요'};
  const show = async () => {
    const value=(await chrome.storage.local.get(STATUS))[STATUS];
    const element=document.getElementById('self-update-status');
    if (element) element.textContent=`도우미 ${chrome.runtime.getManifest().version}${value ? ' · ' + (labels[value.state] || '') + (value.latest ? ` (${value.latest})` : '') : ''}`;
    const button=document.getElementById('self-update-apply');
    if (button) {
      button.hidden=!['waiting','restart'].includes(value?.state);
      button.textContent=value?.state === 'restart' ? '도우미 다시 시작' : '도우미 업데이트 후 재시작';
    }
    const login=document.getElementById('self-update-login');
    if (login) {
      const show=value?.state === 'login_required' && typeof value.postURL === 'string' && value.postURL.startsWith('https://kone.gg/');
      login.hidden=!show;
      if (show) login.href=value.postURL;
    }
  };
  chrome.storage.onChanged?.addListener((changes,area) => { if (area === 'local' && changes[STATUS]) void show(); });
  void show();
  let release, held, restartRequired = false;
  const acquire = () => new Promise(resolve => {
    held = navigator.locks.request(LOCK,{mode:'shared'},async () => {
      let port;
      try {
        const lease=await nativeUpdate('self-lease',{},true); port=lease.port;
        if (lease.result.version !== chrome.runtime.getManifest().version) {
          restartRequired = true;
          await chrome.storage.local.set({[STATUS]:{state:'restart',version:lease.result.version,checkedAt:Date.now()}});
        }
      } catch (error) {
        if (error.message.includes('SELF_BUSY')) { location.reload(); return; }
      }
      await new Promise(done => { release=() => { window.removeEventListener('pagehide',release); done(); }; window.addEventListener('pagehide',release,{once:true}); resolve(); });
      port?.disconnect();
    }).catch(resolve);
  });
  await acquire();
  return {async apply() {
    let zip=null, envelope;
    if (!restartRequired) {
      const status=(await chrome.storage.local.get(STATUS))[STATUS];
      if (status?.state !== 'waiting' || !status.release?.envelope) return {state:'unknown'};
      zip=new Uint8Array(await download(status.release));
      if (zip.length !== status.release.size) throw new Error('내려받은 도우미 ZIP 크기가 배포 정보와 다릅니다.');
      envelope=status.release.envelope;
    }
    const tab=await chrome.tabs.getCurrent();
    await chrome.storage.local.set({[REOPEN]:{tabId:tab?.id,url:location.href,fromVersion:chrome.runtime.getManifest().version}});
    release(); await held;
    let result, restarting=false;
    try {
      await navigator.locks.request(LOCK,{ifAvailable:true},async lock => {
        if (!lock) { result={state:'waiting'}; return; }
        if (restartRequired) { restarting=true; chrome.runtime.reload(); result={state:'updated'}; return; }
        result=(await nativeUpdate('self-apply',{envelope},false,zip)).result;
        if (result.state === 'current' && result.version !== chrome.runtime.getManifest().version) {
          restarting=true; chrome.runtime.reload(); result={...result,state:'updated'}; return;
        }
        if (result.state === 'updated') {
          await chrome.storage.local.set({[STATUS]:{...result,checkedAt:Date.now()}});
          restarting=true; chrome.runtime.reload();
        } else if (result.state === 'current') await chrome.storage.local.set({[STATUS]:{...result,checkedAt:Date.now()}});
      });
      return result;
    } finally {
      if (!restarting) { await acquire(); await chrome.storage.local.remove(REOPEN); }
    }
  }};
}
