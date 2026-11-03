// Paste inside your existing WML.define({ setup(api) { ... } }).
// Keep this version equal to WML.define.version for every release.
const updaterVersion = '1.0.0';
const updaterName = '내 모드';
const updaterPostURL = ''; // A valid API URL takes priority; manual URL is only a missing/invalid API fallback.
if (typeof window !== 'undefined' && typeof window.postMessage === 'function') {
  const key = Symbol.for('wml-mod-updater.' + api.id);
  if (typeof window[key] === 'function') window.removeEventListener('message', window[key]);
  const listener = event => {
    const data = event.data;
    if (event.source !== window || !data || typeof data !== 'object' || Array.isArray(data)
      || data.type !== 'WML_MOD_UPDATER_QUERY' || typeof data.requestId !== 'string'
      || !/^[A-Za-z0-9_-]{1,80}$/.test(data.requestId)
      || Object.keys(data).some(k => k !== 'type' && k !== 'requestId')) return;
    let active = false;
    try { active = window.WML.currentPreset().mods.some(mod => mod.id === api.id); } catch {}
    // file:// has an opaque origin. Send only public version metadata and the active flag.
    window.postMessage({
      type: 'WML_MOD_UPDATER_STATUS', requestId: data.requestId, protocol: 2,
      modId: api.id, modName: updaterName, modVersion: updaterVersion, active,
      wmlVersion: String(api.wml), gameVersion: String(api.game),
      ...(updaterPostURL ? {postURL: updaterPostURL} : {}),
    }, '*');
  };
  window[key] = listener;
  window.addEventListener('message', listener);
}
