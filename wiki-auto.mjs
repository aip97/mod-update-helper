import {AIP_ID, POST_URL, compareVersions, validateModId, validatePostURL} from './core.mjs';
import {gameMatches} from './game-compat.mjs';

// Automatic submissions only describe a locally diagnosed archive; the server must independently verify it.
export function createWikiAuto({storage, sources, diagnose, download, inspect, submit, password, current, mutate, retry = async () => {}, now = Date.now}) {
  let running = false;
  const pending = new Map();
  const optedIn = async () => (await storage.get('wikiAutoSubmit')).wikiAutoSubmit === true;
  const candidate = (game, mod) => {
    try {
      const api = game.api?.[mod.modId];
      if (!mod.supported || !api || ![1,2].includes(api.protocol) || (api.protocol === 1 && mod.modId !== AIP_ID) || (api.protocol === 2 && api.active !== true)) return null;
      const address = api.postURL || (api.protocol === 1 && mod.modId === AIP_ID ? POST_URL : '');
      return {modId:validateModId(mod.modId), gameFamily:game.gameFamily, version:mod.modVersion, postURL:validatePostURL(address), apiVersion:String(api.protocol), name:api.modName || mod.modId};
    } catch { return null; }
  };
  const stillCurrent = async (game, item) => {
    if (!await optedIn()) return false;
    const latest = await current(game.tabId);
    if (!latest || latest.documentId !== game.documentId) return false;
    return latest.mods.some(mod => {
      const found = candidate(latest, mod);
      return found && found.modId === item.modId && found.gameFamily === item.gameFamily && found.version === item.version && found.postURL === item.postURL && found.apiVersion === item.apiVersion;
    });
  };
  async function reserve(item) {
    return mutate(async () => {
      const saved = (await storage.get('wikiAutoAttempts')).wikiAutoAttempts || {};
      const timestamp = now(), times = (Array.isArray(saved.times) ? saved.times : []).filter(t => Number.isFinite(t) && t <= timestamp && timestamp - t < 3600000);
      const key = `${item.gameFamily}\n${item.modId}\n${item.version}\n${item.postURL}\n${item.apiVersion}`;
      const seen = Object.fromEntries(Object.entries(saved.seen || {}).filter(([,entry]) => Number.isFinite(entry?.at) && entry.at <= timestamp && (entry.unknown === true || timestamp - entry.at < (entry.submitted ? 86400000 : 3600000))).slice(-1000));
      if (key in seen) return seen[key].submitted ? {allowed:false} : {allowed:false,retryAt:seen[key].at+3600001};
      if (times.length >= 2) return {allowed:false,retryAt:Math.min(...times)+3600001,rateLimited:true};
      times.push(timestamp); seen[key] = {at:timestamp,submitted:false};
      await storage.set({wikiAutoAttempts:{times,seen}});
      return {allowed:true,retryAt:timestamp+3600001};
    });
  }
  async function record(item, status, {markerOnly=false}={}) {
    await mutate(async () => {
      const values = await storage.get(['wikiAutoStatus','wikiAutoAttempts']);
      const saved = values.wikiAutoStatus;
      const items = Array.isArray(saved) ? saved.filter(entry => entry && (entry.modId !== item.modId || entry.gameFamily !== item.gameFamily)).slice(0,19) : [];
      const update = markerOnly ? {} : {wikiAutoStatus:[{modId:item.modId,gameFamily:item.gameFamily,status,at:now()},...items]};
      const key = `${item.gameFamily}\n${item.modId}\n${item.version}\n${item.postURL}\n${item.apiVersion}`;
      if (['submitted','pending','published','unknown'].includes(status)) {
        const attempts=values.wikiAutoAttempts || {times:[],seen:{}};
        if (!attempts.seen || typeof attempts.seen!=='object') attempts.seen={};
        if (status==='unknown' || markerOnly) attempts.seen[key] ||= {at:now()};
        if (attempts.seen[key]) {
          attempts.seen[key].submitted = true;
          if (status === 'unknown') attempts.seen[key].unknown = true;
          attempts.seen=Object.fromEntries(Object.entries(attempts.seen).slice(-1000));
          update.wikiAutoAttempts=attempts;
        }
      }
      if (Object.keys(update).length) await storage.set(update);
    });
  }
  async function scan(game) {
    if (!await optedIn()) return;
    const candidates = game.mods.map(mod => candidate(game,mod)).filter(Boolean);
    if (!candidates.length) return;
    let approved;
    try { approved = new Set((await sources(candidates.map(item => item.modId))).filter(row => row.game_family === game.gameFamily || row.game_family === 'any').map(row => row.mod_id)); }
    catch {
      for (const item of candidates) if (await stillCurrent(game,item)) await record(item,'error').catch(() => {});
      for (const item of candidates) if (await stillCurrent(game,item)) { await retry(game,now()+3600001).catch(() => {}); break; }
      return;
    }
    let previous=[];
    if (approved.size) {
      try {const saved=(await storage.get('wikiAutoStatus')).wikiAutoStatus; if (Array.isArray(saved)) previous=saved;}
      catch {}
    }
    for (const item of candidates) {
      if (approved.has(item.modId)) {
        if (previous.some(entry=>entry?.modId===item.modId && entry.gameFamily===item.gameFamily && entry.status!=='published') && await stillCurrent(game,item)) await record(item,'published').catch(() => {});
        continue;
      }
      if (!await stillCurrent(game,item)) continue;
      const reservation = await reserve(item);
      if (!reservation.allowed) {
        if (reservation.retryAt) await retry(game,reservation.retryAt).catch(() => {});
        if (reservation.rateLimited) break;
        continue;
      }
      if (!await stillCurrent(game,item)) continue;
      let phase = 'diagnostic_failed';
      const failed = async () => {
        if (!await stillCurrent(game,item)) return;
        await record(item,phase).catch(() => {});
        await retry(game,reservation.retryAt).catch(() => {});
      };
      try {
        const report = await diagnose(item.modId,item.postURL);
        if (!report.ok || !report.release || report.checks.find(check => check.id === 'collection_files')?.status !== 'pass') { await failed(); continue; }
        const release = report.release;
        if (compareVersions(release.version,item.version) < 0) { await failed(); continue; }
        if (!await stillCurrent(game,item)) continue;
        phase = 'archive_failed';
        const savedPassword = await password();
        const bytes = await download({url:release.url,version:release.version,modId:item.modId,fileName:release.fileName,password:savedPassword});
        const pkg = await inspect(bytes,release.version,item.modId);
        const gameCompatible = pkg.gameSpec === '' ? game.gameFamily === 'wayward' : gameMatches(pkg.gameSpec,game.gameVersion);
        if (!gameCompatible || (pkg.supportedWml?.length && !pkg.supportedWml.includes(game.wmlVersion))) { await failed(); continue; }
        if (!await stillCurrent(game,item)) continue;
        const payload = {mod_id:item.modId,name:String(item.name).replace(/[\x00-\x1f\x7f]/g,'').trim().slice(0,100) || item.modId,post_url:item.postURL,wml_versions:pkg.supportedWml || [],game_spec:pkg.gameSpec,description:'설명 미등록',category:'미분류',version:pkg.version,api_version:item.apiVersion};
        phase = 'error';
        const result = await submit('create',payload,'detected');
        await record(item,result?.status === 'approved' ? 'published' : result?.status === 'pending' ? 'pending' : 'submitted',{markerOnly:!await stillCurrent(game,item).catch(() => false)});
      } catch (error) {
        if (phase === 'error' && error?.code === 'WIKI_ALREADY_PENDING') {
          if (await stillCurrent(game,item)) await record(item,'pending').catch(() => {});
        } else if (phase === 'error' && error?.code === 'SUBMISSION_UNKNOWN') {
          await record(item,'unknown',{markerOnly:!await stillCurrent(game,item).catch(() => false)}).catch(() => {});
        } else await failed();
      }
    }
  }
  async function drain() {
    if (running) return;
    running = true;
    try { while (pending.size) { const [key,game] = pending.entries().next().value; pending.delete(key); await scan(game); } }
    finally { running = false; }
  }
  return game => {
    if (!game || !Number.isInteger(game.tabId) || typeof game.documentId !== 'string') return;
    const key = `${game.tabId}\n${game.documentId}`;
    pending.set(key,game);
    if (pending.size > 100) pending.delete(pending.keys().next().value);
    void drain().catch(() => {});
  };
}
