(() => {
  if (window.top !== window || !/\.html?$/i.test(location.pathname)) return;
  if (globalThis.__wmlUpdaterBridge?.version === '0.8.1') return;
  globalThis.__wmlUpdaterBridge?.dispose?.();
  const notified = new Set(), requests = new Map();
  const validId = id => typeof id === 'string' && id.length <= 100 && /^[a-zA-Z0-9._-]+$/.test(id);
  const bounded = (value, max) => typeof value === 'string' && value.length <= max && !/[\x00-\x1f]/.test(value);
  const bridge = event => {
    const value = event.data;
    if (event.source !== window || typeof value?.requestId !== 'string') return;
    const request = requests.get(value.requestId);
    if (!request) return;
    if (value.type === 'WML_UPDATER_SNAPSHOT') {
      const data = value.snapshot;
      if (!data || !Array.isArray(data.mods) || data.mods.length > 500 || !bounded(data.wmlVersion, 64) || !bounded(data.gameVersion, 64)) return;
      if (!data.mods.every(mod => mod && bounded(mod.id, 100) && bounded(mod.version, 64))) return;
      if (data.htmlVersion !== undefined && !bounded(data.htmlVersion, 64)) return;
      request.snapshot = {wmlVersion: data.wmlVersion, gameVersion: data.gameVersion, ...(data.htmlVersion !== undefined ? {htmlVersion: data.htmlVersion} : {}), mods: data.mods.map(mod => ({id: mod.id, version: mod.version}))};
      if(data.gameUpdate && JSON.stringify(data.gameUpdate).length<=8192) request.snapshot.gameUpdate=data.gameUpdate;
      return;
    }
    if (!['WML_MOD_UPDATER_STATUS', 'AIP_UPDATER_STATUS'].includes(value.type) || !validId(value.modId) || request.apis.size >= 500) return;
    if ((value.type === 'WML_MOD_UPDATER_STATUS' && (value.protocol !== 2 || typeof value.active !== 'boolean')) || (value.type === 'AIP_UPDATER_STATUS' && (value.protocol !== 1 || value.modId !== 'attention-image-prompt'))) return;
    if (request.apis.get(value.modId)?.protocol === 2 && value.protocol === 1) return;
    const api = {modId: value.modId, protocol: value.protocol, active: value.active};
    if (bounded(value.modName, 100)) api.modName = value.modName;
    if (value.postURL !== undefined) api.postURL = bounded(value.postURL, 2048) ? value.postURL : '';
    request.apis.set(value.modId, api);
  };
  window.addEventListener('message', bridge);
  function readSnapshot() {
    if (requests.size >= 10) return Promise.resolve({ok: false});
    return new Promise(resolve => {
      const requestId = crypto.randomUUID(), request = {apis: new Map(), snapshot: null};
      requests.set(requestId, request);
      setTimeout(() => { requests.delete(requestId); resolve({ok: !!request.snapshot, snapshot: request.snapshot, apis: [...request.apis.values()]}); }, 350);
      for (const type of ['WML_UPDATER_SNAPSHOT_QUERY', 'WML_MOD_UPDATER_QUERY', 'AIP_UPDATER_QUERY']) window.postMessage({type, requestId}, '*');
    });
  }
  let attempts = 0, previous;
  const query = async () => {
    if (attempts++ >= 20) return clearInterval(timer);
    const reply = await readSnapshot();
    const signature = JSON.stringify(reply);
    if (!reply.ok || signature === previous) return;
    try {
      const saved = await chrome.runtime.sendMessage({type: 'GAME_SNAPSHOT', snapshot: reply.snapshot, apis: reply.apis});
      if (saved?.ok) previous = signature;
    } catch {}
  };
  const timer = setInterval(query, 1500); query();
  const receive = (message, sender, respond) => {
    if (message?.type === 'READ_SNAPSHOT') {
      readSnapshot().then(async reply => {
        if (message.connect && reply.ok) await chrome.runtime.sendMessage({type: 'GAME_SNAPSHOT', snapshot: reply.snapshot, apis: reply.apis});
        respond(reply);
      }).catch(() => respond({ok: false}));
      return true;
    }
    if (!['UPDATE_AVAILABLE','GAME_UPDATE_AVAILABLE','HELPER_UPDATE_AVAILABLE'].includes(message?.type)) return;
    const noticeId=message.type==='GAME_UPDATE_AVAILABLE'?'@game':message.type==='HELPER_UPDATE_AVAILABLE'?'@helper':message.modId;
    if(notified.has(noticeId)) return;
    notified.add(noticeId);
    let stack = document.getElementById('wml-browser-updater-notices');
    if (!stack) {
      stack = document.createElement('div'); stack.id = 'wml-browser-updater-notices';
      stack.style.cssText = 'position:fixed;right:18px;top:18px;z-index:2147483647;max-width:340px;max-height:80vh;overflow:auto';
      (document.body || document.documentElement).append(stack);
    }
    const box = document.createElement('aside'); box.setAttribute('role', 'status');
    box.style.cssText = 'margin-bottom:10px;background:#192229;color:#fff;padding:18px;border:1px solid #d6b981;border-radius:8px;font:14px/1.6 sans-serif;box-shadow:0 5px 25px #0008';
    const label = document.createElement('div'); label.textContent = `${message.type==='GAME_UPDATE_AVAILABLE'?'게임 본체':message.type==='HELPER_UPDATE_AVAILABLE'?'모드 업데이트 도우미':message.modName || message.modId} ${message.current} → ${message.version} 업데이트가 있습니다.`;
    const open = document.createElement('button'); open.textContent = '업데이트 확인';
    const later = document.createElement('button'); later.textContent = '나중에';
    for (const button of [open, later]) button.style.cssText = 'margin:12px 8px 0 0;padding:7px 11px;cursor:pointer';
    open.onclick = () => chrome.runtime.sendMessage({type: 'OPEN_UPDATER', ...(message.type==='UPDATE_AVAILABLE'?{modId:message.modId}:message.type==='GAME_UPDATE_AVAILABLE'?{view:'game'}:{})}).catch(() => {});
    later.onclick = () => box.remove(); box.append(label, open, later); stack.append(box);
  };
  chrome.runtime.onMessage.addListener(receive);
  globalThis.__wmlUpdaterBridge={version:'0.8.1',dispose(){
    clearInterval(timer); window.removeEventListener('message',bridge); chrome.runtime.onMessage.removeListener(receive);
    document.getElementById('wml-browser-updater-notices')?.remove();
  }};
})();
