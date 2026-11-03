const LOCK = 'wml-mod-updater-self-update';
const STATUS = 'helperUpdateStatus';
export function nativeUpdate(op, values = {}, keepOpen = false) {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connectNative('org.wml.mod_updater');
    let settled = false;
    const timer = setTimeout(() => { port.disconnect(); reject(new Error('업데이트 응답 시간이 초과되었습니다.')); }, 120000);
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
export function startSelfUpdates() {
  if (!chrome.alarms || !chrome.runtime.getManifest) return;
  let running = false;
  const save = result => chrome.storage.local.set({[STATUS]:{...result,checkedAt:Date.now()}});
  async function run(force = false) {
    if (running) return;
    running = true;
    try {
      await nativeUpdate('self-confirm',{version:chrome.runtime.getManifest().version});
      const previous=(await chrome.storage.local.get(STATUS))[STATUS];
      if (!force && previous && Date.now()-previous.checkedAt < 21600000 && previous.state !== 'waiting') return;
      let {result} = await nativeUpdate('self-check');
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
  const labels={current:'도우미 최신 상태',unconfigured:'도우미 자동 업데이트: 배포 저장소 준비 중',waiting:'새 도우미 버전 준비됨 · 이 창을 닫으면 적용',updated:'도우미 업데이트 완료',blocked:'이전 도우미 버전으로 복구됨',error:'도우미 자동 업데이트 연결 확인 필요'};
  const show = async () => {
    const value=(await chrome.storage.local.get(STATUS))[STATUS];
    const element=document.getElementById('self-update-status');
    if (element && value) element.textContent=labels[value.state] || '';
  };
  chrome.storage.onChanged?.addListener((changes,area) => { if (area === 'local' && changes[STATUS]) void show(); });
  void show();
  // Hold both browser and native leases until the page closes, including confirmations and queued jobs.
  return new Promise(resolve => {
    navigator.locks.request(LOCK,{mode:'shared'},async () => {
      let port;
      try {
        const lease=await nativeUpdate('self-lease',{},true); port=lease.port;
        if (lease.result.version !== chrome.runtime.getManifest().version) { port.disconnect(); chrome.runtime.reload(); return; }
      } catch (error) {
        if (error.message.includes('SELF_BUSY')) { location.reload(); return; }
      }
      resolve();
      await new Promise(done => window.addEventListener('pagehide',done,{once:true}));
      port?.disconnect();
    }).catch(resolve);
  });
}
