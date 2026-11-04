const LOCK = 'wml-mod-updater-self-update';
const STATUS = 'helperUpdateStatus';
const REOPEN = 'helperUpdateReopen';
export function nativeUpdate(op, values = {}, keepOpen = false) {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connectNative('org.wml.mod_updater');
    let settled = false;
    const timer = setTimeout(() => { port.disconnect(); reject(new Error('업데이트 응답 시간이 초과되었습니다.')); }, op === 'self-apply' ? 900000 : 120000);
    port.onDisconnect.addListener(() => { clearTimeout(timer); if (!settled) reject(new Error(chrome.runtime.lastError?.message || '설치 도우미 연결 종료')); });
    port.onMessage.addListener(message => {
      if (message?.id !== 1) return;
      settled = true;
      clearTimeout(timer);
      if (!keepOpen || !message.ok) port.disconnect();
      if (message.ok) resolve({result:message.result,port});
      else reject(new Error(message.error || '도우미 업데이트 실패'));
    });
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
export function startSelfUpdates() {
  if (!chrome.alarms || !chrome.runtime.getManifest) return;
  let running = false;
  void reopenUpdaterWindow().catch(() => {});
  const save = result => chrome.storage.local.set({[STATUS]:{...result,checkedAt:Date.now()}});
  async function run(force = false) {
    if (running) return;
    running = true;
    try {
      await nativeUpdate('self-confirm',{version:chrome.runtime.getManifest().version});
      const previous=(await chrome.storage.local.get(STATUS))[STATUS];
      if (!force && previous && Date.now()-previous.checkedAt < 21600000 && previous.state !== 'waiting') return;
      let {result} = await nativeUpdate('self-check');
      if (result.state === 'current' && previous?.state === 'updated' && previous.version === result.version) result=previous;
      if (result.state === 'available') {
        await navigator.locks.request(LOCK,{ifAvailable:true},async lock => {
          if (!lock) { result={...result,state:'waiting'}; return; }
          result=(await nativeUpdate('self-apply')).result;
          await save(result);
          if (result.state === 'updated') chrome.runtime.reload();
        });
      }
      await save(result);
      if (result.state === 'waiting') await chrome.alarms.create('helper-update-retry',{delayInMinutes:1});
    } catch (error) {
      if (error.message.includes('SELF_RESTART')) {
        await navigator.locks.request(LOCK,{ifAvailable:true},async lock => {
          if (lock) chrome.runtime.reload();
          else await chrome.alarms.create('helper-update-retry',{delayInMinutes:1});
        });
      } else await save({state:'error',message:error.message});
    } finally { running=false; }
  }
  chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name.startsWith('helper-update-')) void run(true); });
  chrome.runtime.onStartup.addListener(() => void run(true));
  chrome.runtime.onInstalled.addListener(() => void run(true));
  void chrome.alarms.create('helper-update-check',{periodInMinutes:360});
  void run();
}
export async function holdUpdaterWindow() {
  if (!chrome.runtime.getManifest || !chrome.runtime.connectNative || !navigator.locks) return;
  const labels={current:'최신 상태',unconfigured:'자동 업데이트: 배포 저장소 준비 중',waiting:'새 버전이 있습니다',updated:'업데이트 완료',blocked:'이전 버전으로 복구됨',error:'자동 업데이트 연결 확인 필요'};
  const show = async () => {
    const value=(await chrome.storage.local.get(STATUS))[STATUS];
    const element=document.getElementById('self-update-status');
    if (element) element.textContent=`도우미 ${chrome.runtime.getManifest().version}${value ? ' · ' + (labels[value.state] || '') + (value.latest ? ` (${value.latest})` : '') : ''}`;
    const button=document.getElementById('self-update-apply');
    if (button) button.hidden=value?.state !== 'waiting';
  };
  chrome.storage.onChanged?.addListener((changes,area) => { if (area === 'local' && changes[STATUS]) void show(); });
  void show();
  let release, held;
  const acquire = () => new Promise(resolve => {
    held = navigator.locks.request(LOCK,{mode:'shared'},async () => {
      let port;
      try {
        const lease=await nativeUpdate('self-lease',{},true); port=lease.port;
        if (lease.result.version !== chrome.runtime.getManifest().version) { port.disconnect(); chrome.runtime.reload(); return; }
      } catch (error) {
        if (error.message.includes('SELF_BUSY')) { location.reload(); return; }
      }
      await new Promise(done => { release=() => { window.removeEventListener('pagehide',release); done(); }; window.addEventListener('pagehide',release,{once:true}); resolve(); });
      port?.disconnect();
    }).catch(resolve);
  });
  await acquire();
  return {async apply() {
    const tab=await chrome.tabs.getCurrent();
    await chrome.storage.local.set({[REOPEN]:{tabId:tab?.id,url:location.href,fromVersion:chrome.runtime.getManifest().version}});
    release(); await held;
    let result, restarting=false;
    try {
      await navigator.locks.request(LOCK,{ifAvailable:true},async lock => {
        if (!lock) { result={state:'waiting'}; return; }
        result=(await nativeUpdate('self-apply')).result;
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
