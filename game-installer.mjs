import {readArchive, inspectGameRoot, readFile, readOptional, writeFile, replaceFile, fingerprint, matches, compareVersions} from './installer.mjs';
import {inspectGameHTML, compareGameVersions, supportsWmlVersion} from './game-compat.mjs';

const FILE_LIMIT=64*1024*1024, TOTAL_LIMIT=1024*1024*1024;
const decoder=new TextDecoder('utf-8',{fatal:true}), encoder=new TextEncoder();
const need=(ok,message)=>{if(!ok) throw new Error(message);};
const sha256=async data=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),n=>n.toString(16).padStart(2,'0')).join('');
export function preservedGamePath(path,preserve=[]) {
  const lower=path.toLowerCase();
  return /^(?:wml\/(?:mods|presets)|image-packs)(?:\/|$)/.test(lower)
    || /(?:^|\/)(?:saves?|savedata|userdata|user-data|profiles?|settings|config|cache|caches|backups?|logs?|node_modules)(?:\/|\.|$)/.test(lower) && !/\.(?:ts|js|mjs|cjs)$/.test(lower)
    || /(?:^|\/)[^/]*(?:server|imagegen)[^/]*\/images(?:\/|$)/.test(lower)
    || /(?:^|\/)(?:[^/]+\.)?(?:config|settings)\.json$/.test(lower)
    || preserve.some(item=>lower===item.toLowerCase() || lower.startsWith(item.toLowerCase()+'/'));
}
export async function inspectGamePackage(zipBytes, release, current) {
  need(release && compareGameVersions(release.gameVersion,current.gameVersion)>0,'같거나 이전 게임 버전은 설치하지 않습니다.');
  need(typeof release.html==='string' && /^[^\\/<>:"|?*\x00-\x1f]+\.html?$/i.test(release.html),'게임 HTML 파일명이 올바르지 않습니다.');
  const entries=await readArchive(zipBytes,{maxZip:512*1024*1024,maxFile:FILE_LIMIT,maxTotal:TOTAL_LIMIT,maxEntries:8192});
  const games=entries.filter(entry=>!entry.isDir && (entry.path===release.html || entry.path.endsWith('/'+release.html)));
  need(games.length===1,'게임 ZIP 안에서 배포 HTML을 하나로 확인할 수 없습니다.');
  const html=games[0], archiveRoot=html.path.slice(0,-release.html.length);
  const info=inspectGameHTML(decoder.decode(html.data));
  need(info.gameVersion===release.gameVersion && info.gameFamily===current.gameFamily,'ZIP 파일명과 HTML의 게임 계열·버전이 다릅니다.');
  const runtime=entries.find(entry=>entry.path===archiveRoot+'wml/runtime/wml-core.js' && !entry.isDir);
  const wmlVersion=runtime && decoder.decode(runtime.data.subarray(0,16000)).match(/\bconst VERSION = ['"]([^'"]+)['"]/)?.[1];
  need(supportsWmlVersion(wmlVersion,info.gameVersion),'게임 ZIP에 지원되는 WML 런타임이 없습니다.');
  need(compareVersions(wmlVersion,current.wmlVersion)>=0,'게임 ZIP의 WML 버전이 현재 설치보다 낮습니다.');
  const files=[],skipped=[];
  for(const entry of entries) {
    if(entry.isDir && archiveRoot.startsWith(entry.path)) continue;
    need(entry.path.startsWith(archiveRoot),'게임 ZIP의 포장 폴더 밖에 파일이 있습니다.');
    if(entry.isDir) continue;
    const path=entry.path.slice(archiveRoot.length);
    if(preservedGamePath(path,release.preserve)) {skipped.push(path);continue;}
    need(/\.(?:html?|[cm]?js|ts|json|css|md|txt|png|jpe?g|webp|gif|avif|svg|ico|woff2?|ttf|otf|mp3|ogg|wav|m4a|mp4|webm|lock|cmd|bat|ps1)$/i.test(path) || /(?:^|\/)LICENSE(?:\.[\w-]+)?$/i.test(path),`지원하지 않는 게임 배포 파일: ${path}`);
    if(/\.html?$/i.test(path) && entry!==html) {
      need(!/WML_BRIDGE_BEGIN|<script\b[^>]*\bsrc\s*=\s*['"](?:\.\/)?wml\/runtime\/wml-core\.js['"]/i.test(decoder.decode(entry.data)),'여러 게임 HTML이 혼합된 ZIP은 설치할 수 없습니다.');
    }
    files.push({path:entry===html?current.gameFile:path,data:entry.data});
  }
  need(files.some(file=>file.path===current.gameFile) && files.some(file=>file.path==='wml/runtime/wml-core.js'),'게임 HTML 또는 런타임을 보존 경로로 지정할 수 없습니다.');
  need(new Set(files.map(file=>file.path.toLowerCase())).size===files.length,'게임 HTML 이름을 유지할 때 다른 파일과 충돌합니다.');
  return {...info,wmlVersion,files,skipped,archiveRoot};
}

// The caller holds the same browser lock as mod updates and confirms every game tab is closed.
export async function applyGameUpdate(root, pkg, {current,checkClosed,onProgress=()=>{}}) {
  need(typeof checkClosed==='function','게임 종료 확인이 필요합니다.');
  await checkClosed();
  const identity=await inspectGameRoot(root,{gameFile:current.gameFile});
  need(identity.gameVersion===current.gameVersion && identity.wmlVersion===current.wmlVersion,'준비 중 게임 버전이 변경되었습니다.');
  need(pkg.gameFamily===identity.gameFamily && compareGameVersions(pkg.gameVersion,identity.gameVersion)>0,'다른 계열 또는 이전 게임 버전은 설치할 수 없습니다.');
  const backupPath=`.wml-game-updater-backups/${crypto.randomUUID()}`;
  if(root.authorizeGameUpdate) await root.authorizeGameUpdate(pkg.files.map(file=>file.path),backupPath);
  const originals=new Map(),entries=[];let total=0;
  onProgress('기존 게임 파일을 백업하고 있습니다…');
  for(const file of pkg.files) {
    if(entries.length%10===0) onProgress(`게임 파일 백업 중… ${entries.length}/${pkg.files.length}`);
    const data=await readOptional(root,file.path,FILE_LIMIT), old=fingerprint(data), next=fingerprint(file.data);
    need((total+=data?.length||0)<=TOTAL_LIMIT,'게임 백업 합계가 1 GiB를 넘습니다.');
    originals.set(file.path,data);
    if(data!==null) {
      await writeFile(root,backupPath+'/'+file.path,data);
      need(matches(await readOptional(root,backupPath+'/'+file.path,FILE_LIMIT),old.length,old.crc),'게임 백업 무결성 검사에 실패했습니다.');
    }
    entries.push({path:file.path,original:old ? {...old,sha256:await sha256(data)} : null,current:next});
  }
  const manifest={schema:1,gameFile:current.gameFile,previousVersion:current.gameVersion,version:pkg.gameVersion,files:entries};
  await writeFile(root,backupPath+'/manifest.json',encoder.encode(JSON.stringify(manifest,null,2)));
  need(JSON.stringify(JSON.parse(await (await readFile(root,backupPath+'/manifest.json')).text()))===JSON.stringify(manifest),'게임 백업 목록 검사에 실패했습니다.');
  await checkClosed();
  for(const entry of entries) need(matches(await readOptional(root,entry.path,FILE_LIMIT),entry.original?.length??null,entry.original?.crc??null),'백업 중 게임 파일이 변경되었습니다.');
  const ordered=[...pkg.files].sort((a,b)=>Number(a.path===current.gameFile)-Number(b.path===current.gameFile)),touched=[];
  if(root.armGameUpdate) await root.armGameUpdate();
  try {
    onProgress('게임 파일을 설치하고 있습니다. 이 창을 닫지 마세요…');
    for(const file of ordered) {
      if(touched.length%10===0) onProgress(`게임 파일 설치 중… ${touched.length}/${ordered.length} · 이 창을 닫지 마세요.`);
      await checkClosed(); touched.push(file.path); await writeFile(root,file.path,file.data);
    }
    for(const entry of entries) need(matches(await readOptional(root,entry.path,FILE_LIMIT),entry.current.length,entry.current.crc),'게임 설치 후 파일 검사에 실패했습니다.');
    need((await inspectGameRoot(root,{gameFile:current.gameFile})).gameVersion===pkg.gameVersion,'설치한 게임 HTML의 버전이 다릅니다.');
  } catch(error) {
    const failed=[];onProgress('설치 실패로 이전 파일을 복원하고 있습니다…');
    for(const path of touched.reverse().sort((a,b)=>Number(a===current.gameFile)-Number(b===current.gameFile))) {
      try {
        const old=originals.get(path),hash=fingerprint(old);
        await replaceFile(root,path,old);
        need(matches(await readOptional(root,path,FILE_LIMIT),hash?.length??null,hash?.crc??null),'복구 검사 실패');
      } catch {failed.push(path);}
    }
    if(!failed.length && root.finishGameUpdate) await root.finishGameUpdate();
    throw new Error(`${error.message} ${failed.length?'복원하지 못한 파일: '+failed.join(', '):'변경한 파일을 이전 상태로 복원했습니다.'} 백업: ${backupPath}`);
  }
  if(root.finishGameUpdate) await root.finishGameUpdate();
  return {version:pkg.gameVersion,previousVersion:current.gameVersion,filesWritten:pkg.files.length,backupPath};
}
