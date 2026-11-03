(() => {
  if (window.top !== window || !/\.html?$/i.test(location.pathname)) return;
  if (window.__wmlUpdaterReader?.version === '0.7.1') return;
  window.__wmlUpdaterReader?.dispose?.();
  const plain = value => typeof value === 'string' && value.length > 0 && value.length <= 64 && !/[\x00-\x1f]/.test(value);
  const read = event => {
    const request = event.data;
    if (event.source !== window || !request || Array.isArray(request) || Object.keys(request).length !== 2 || request.type !== 'WML_UPDATER_SNAPSHOT_QUERY' || typeof request.requestId !== 'string' || !/^[\w-]{1,80}$/.test(request.requestId)) return;
    let snapshot = null;
    try {
      const preset = window.WML?.currentPreset();
      const wmlVersion = preset?.wml || window.WML?.VERSION, gameVersion = preset?.game;
      if (Array.isArray(preset?.mods) && preset.mods.length <= 500 && plain(wmlVersion) && plain(gameVersion)) {
        const mods = preset.mods.map(mod => ({id: mod.id, version: typeof mod.version === 'string' ? (mod.version.length > 64 ? mod.version.slice(0, 63) + '…' : mod.version).replace(/[\x00-\x1f]/g, '�') : ''}));
        const declarations = [];
        for (const [name, prefix] of [['wml-game',''], ['wf-version','faith-'], ['ot-version','overtime-']]) {
          const meta = document.querySelector?.(`meta[name="${name}"]`);
          if (meta) declarations.push(plain(meta.content) ? prefix + meta.content : '');
        }
        if (window.WML_GAME !== undefined) declarations.push(window.WML_GAME);
        if (declarations.some(value => !plain(value) || value !== gameVersion)) throw new Error('HTML game version mismatch');
        const htmlVersion = declarations[0];
        if (mods.every(mod => typeof mod.id === 'string' && mod.id.length > 0 && mod.id.length <= 100 && !/[\x00-\x1f]/.test(mod.id))) snapshot = {mods, wmlVersion, gameVersion, ...(typeof htmlVersion === 'string' ? {htmlVersion} : {})};
        const api=window.WML_GAME_UPDATER;
        if(snapshot && api && JSON.stringify(api).length<=8192) snapshot.gameUpdate=JSON.parse(JSON.stringify(api));
      }
    } catch {}
    window.postMessage({type: 'WML_UPDATER_SNAPSHOT', requestId: request.requestId, snapshot}, '*');
  };
  window.addEventListener('message', read);
  window.__wmlUpdaterReader={version:'0.7.1',dispose(){window.removeEventListener('message',read);}};
})();
