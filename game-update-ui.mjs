import {connectNativeGameFolder} from './native-filesystem.mjs';
import {readModMetadata,evaluateCompatibility} from './installer.mjs';
import {scanDownloadedZip} from './defender-scan.mjs';

export function sameGameFolder(tabURL,gameURL) {
  try {
    const tab=new URL(tabURL), game=new URL(gameURL);
    return tab.protocol==='file:' && game.protocol==='file:' && /\.html?$/i.test(tab.pathname)
      && decodeURIComponent(new URL('.',tab).href).toLowerCase()===decodeURIComponent(new URL('.',game).href).toLowerCase();
  } catch {return false;}
}
export function initGameUpdater({message,askPassword,getPassword,isBusy,setBusy,onInstalled}) {
  const $=id=>document.getElementById(id);
  let game,source,release,prepared,sequence=0;
  const status=value=>{$('game-update-status').textContent=value;};
  const tabs=async()=> (await chrome.tabs.query({})).filter(tab=>sameGameFolder(tab.url,game.url));
  const checkClosed=async()=>{if((await tabs()).length) throw new Error('이 게임 폴더의 HTML 탭이 열려 있습니다. 게임을 종료한 뒤 다시 시도해 주세요.');};
  const refresh=()=>{
    $('game-edition').disabled=isBusy() || !source;
    $('game-check').disabled=isBusy() || !source;
    $('game-diagnose').disabled=isBusy() || !source;
    $('game-prepare').disabled=isBusy() || !release?.available;
  };
  const check=async(prompt=false)=>{
    if(prompt && !await askPassword()) return false;
    const checkedGame=game,edition=$('game-edition').value;
    let result;
    try { result=await message({type:'CHECK_GAME_RELEASE',tabId:game.tabId,documentId:game.documentId,edition:$('game-edition').value}); }
    catch(error) {
      if(!prompt || error.code!=='PASSWORD_REQUIRED' || !await askPassword(true)) throw error;
      result=await message({type:'CHECK_GAME_RELEASE',tabId:game.tabId,documentId:game.documentId,edition:$('game-edition').value});
    }
    if(game!==checkedGame || $('game-edition').value!==edition) return false;
    release=result;
    status(`${game.gameVersion} → ${result.release.gameVersion} · ${result.available?'새 게임 버전이 있습니다. 다운로드·검사 후 설치 내용을 확인하세요.':'현재 배포 버전보다 같거나 높습니다.'}${result.release.filenameWarning?'\n'+result.release.filenameWarning:''}`);
    return true;
  };
  $('game-edition').onchange=()=>{release=null;status('배포판을 선택했습니다. 새 버전을 확인하세요.');refresh();};
  const checkPost=async(diagnose=false)=>{
    if(isBusy()) return;setBusy(true);release=null;status('게임 배포 게시글과 파일을 확인하고 있습니다…');
    $('game-diagnostic-guidance').hidden=!diagnose;
    try {
      if(!await check(true)) status('게임 버전 확인을 취소했습니다.');
      else if(diagnose) {
        const file=release.release;
        status(`게시글 링크·ZIP 파일명 검사 완료\n게시글 제목의 버전은 필요하지 않습니다.\n확인한 파일: ${file.fileName}\n파일명 버전: ${file.gameVersion}\n다운로드 컬렉션: ${file.url}\nZIP 내부 HTML 예상 위치: <게임 폴더>/${file.html}\nHTML 내용·버전·ZIP 구조는 다운로드·검사 단계에서 확인합니다.${file.filenameWarning?'\n'+file.filenameWarning:''}`);
      }
    }catch(error){status(error.message);}finally{setBusy(false);refresh();}
  };
  $('game-check').onclick=()=>checkPost();
  $('game-diagnose').onclick=()=>checkPost(true);
  $('game-prepare').onclick=async()=>{
    if(isBusy() || !release?.available) return;
    setBusy(true);let root;
    try {
      if(!await askPassword()) return;
      await check();if(!release.available) return;
      const target={...release.release},running={...game};
      const {inspectGameRoot}=await import('./installer.mjs');
      const {inspectGamePackage}=await import('./game-installer.mjs');
      root=await connectNativeGameFolder(running.url);
      const current=await inspectGameRoot(root,{gameFile:root.gameFile});
      if(current.gameVersion!==running.gameVersion || current.wmlVersion!==running.wmlVersion) throw new Error('실행 중인 게임과 디스크의 버전이 다릅니다. 게임을 다시 열어 주세요.');
      status(`${target.fileName} 다운로드·검사 중… (${(target.size/1024/1024).toFixed(1)} MiB)`);
      const {downloadKioFile}=await import('./kio-api.mjs');
      const bytes=await downloadKioFile({url:target.url,fileName:target.fileName,password:getPassword(),maxBytes:512*1024*1024});
      status('Windows 보안으로 게임 ZIP을 검사하고 있습니다…');
      await scanDownloadedZip(bytes);
      const pkg=await inspectGamePackage(bytes,target,current),warnings=[];
      for(const mod of running.mods) {
        try {
          const compatibility=evaluateCompatibility(await readModMetadata(root,mod.modId),pkg.wmlVersion,pkg.gameVersion);
          if(compatibility.gameState!=='supported' || compatibility.state!=='supported') warnings.push(mod.modName || mod.modId);
        } catch {warnings.push(mod.modName || mod.modId);}
      }
      const openTabs=await tabs();
      prepared={root,current,pkg,running,openTabs};root=null;
      $('game-confirm-description').textContent=`${current.gameVersion} → ${pkg.gameVersion} · ${target.label}\n경로: ${prepared.root.path}\n기존 HTML: ${current.gameFile} (파일명 유지)\n교체 ${pkg.files.length}개 · 보존 ${pkg.skipped.length}개 · 같은 폴더의 HTML 탭 ${openTabs.length}개 종료\n${warnings.length?'새 버전에서 호환되지 않거나 호환 정보를 확인하지 못한 활성 모드: '+warnings.join(', '):'활성 모드의 게임·WML 선언은 일치합니다. 실제 충돌 여부는 확인할 수 없습니다.'}`;
      $('game-saved').checked=false;$('game-install-confirm').disabled=true;
      $('game-confirm').returnValue='cancel';$('game-confirm').showModal();
      status('다운로드·검사를 마쳤습니다. 게임을 저장하고 설치를 확인해 주세요.');
    } catch(error) {status(error.message);}
    finally {root?.disconnect();if(!prepared) setBusy(false);refresh();}
  };
  $('game-saved').onchange=()=>{$('game-install-confirm').disabled=!$('game-saved').checked;};
  $('game-confirm').addEventListener('close',async()=>{
    const approved=prepared;prepared=null;if(!approved) return;
    try {
      if($('game-confirm').returnValue!=='install' || !$('game-saved').checked) {status('게임 설치를 취소했습니다. 파일을 변경하지 않았습니다.');return;}
      if(!navigator.locks) throw new Error('이 브라우저에서는 동시 업데이트 보호 기능을 사용할 수 없습니다.');
      await navigator.locks.request('wml-mod-updater-install',{ifAvailable:true},async lock=>{
        if(!lock) throw new Error('다른 모드·게임 업데이트가 진행 중입니다. 완료 후 다시 시도하세요.');
        const active=(await message({type:'GET_GAME',tabId:approved.running.tabId})).game;
        if(!active || active.documentId!==approved.running.documentId || active.url!==approved.running.url || active.gameVersion!==approved.running.gameVersion) throw new Error('확인 중 게임이 변경되었습니다. 새로 검사해 주세요.');
        const currentTabs=await tabs();
        if(currentTabs.some(tab=>!approved.openTabs.some(old=>old.id===tab.id && old.url===tab.url))) throw new Error('확인 후 새로운 게임 탭이 열렸습니다. 새로 검사해 주세요.');
        status('확인한 게임 탭을 닫고 있습니다…');
        if(currentTabs.length) await chrome.tabs.remove(currentTabs.map(tab=>tab.id));
        await checkClosed();
        const {applyGameUpdate}=await import('./game-installer.mjs');
        const result=await applyGameUpdate(approved.root,approved.pkg,{current:approved.current,checkClosed,onProgress:status});
        release=null;
        status(`${result.version} 설치 완료 · 백업: ${result.backupPath}\n게임 다시 열기를 누르면 새 버전으로 시작합니다.`);
        $('game-open').hidden=false;$('game-open').onclick=()=>chrome.tabs.create({url:approved.running.url});
        onInstalled();
      });
    } catch(error){status(error.message);}
    finally{approved.root.disconnect();setBusy(false);refresh();}
  });
  return {refresh,async load(value){
    game=value;source=null;release=null;const token=++sequence;
    $('game-open').hidden=true;$('game-source-link').hidden=true;$('game-edition').replaceChildren();refresh();
    if(!game){status('게임을 실행하면 본체 업데이트 연결을 확인합니다.');return;}
    try {
      const result=await message({type:'GET_GAME_SOURCE',tabId:game.tabId,documentId:game.documentId});
      if(token!==sequence) return;
      source=result.source;
      if(!source){status('이 게임에 본체 업데이트 API가 등록되지 않았습니다. 제작자가 배포 게시글·파일명 규칙을 연결하면 자동으로 새 버전을 확인합니다.');return;}
      for(const item of source.packages){const option=document.createElement('option');option.value=item.id;option.textContent=item.label;$('game-edition').append(option);}
      $('game-edition').value=result.edition;
      $('game-source-link').href=source.postURL;$('game-source-link').hidden=false;
      await check();
    } catch(error){status(error.message);}
    finally{refresh();}
  }};
}
