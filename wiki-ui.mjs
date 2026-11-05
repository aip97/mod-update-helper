import {compareVersions,validateModId,validatePostURL,validateReleaseURL} from './core.mjs';
import {gameFamilyLabel,gameMatches,parseGameRequirement,parseGameVersion} from './game-compat.mjs';
import {inspectPackage,evaluateCompatibility} from './installer.mjs';
import {downloadRelease} from './kio.js';
import {scanDownloadedZip} from './defender-scan.mjs';
import {connectNativeGameFolder} from './native-filesystem.mjs';
import {ensureNewFolder,installNewMod} from './wiki-install.mjs';
import {listWikiMods,submitWikiMod} from './wiki-client.mjs';

const text = (value, limit) => typeof value === 'string' ? value.trim().slice(0,limit) : '';
const wikiGameFamily = row => {
  try { return row.game_spec ? parseGameRequirement(row.game_spec).gameFamily : 'wayward'; }
  catch { return '__unknown'; }
};
const wikiGameLabel = family => family==='__unknown' ? '미확인' : family==='wayward' ? '일반 Wayward' : gameFamilyLabel(family);
const GAME_FAMILIES=['wayward','faith','overtime','any'];
export function wikiGameSpec(family,other,versions) {
  const actual=family==='__other' ? other.trim() : family;
  if(!GAME_FAMILIES.includes(family) && family!=='__other') throw new Error('대상 게임을 선택해 주세요.');
  if(family==='__other' && (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(actual) || ['wayward','faith','overtime','any'].includes(actual))) throw new Error('기타 게임 ID는 영문 소문자와 숫자로 입력해 주세요.');
  if(!Array.isArray(versions) || versions.length>20 || versions.some(value=>typeof value!=='string' || !value.trim()) || new Set(versions.map(value=>value.trim())).size!==versions.length) throw new Error('게임 버전은 중복 없이 최대 20개까지 입력해 주세요.');
  if(family==='any') {
    if(versions.length) throw new Error('모든 게임 공용에는 개별 게임 버전을 입력할 수 없습니다.');
    return '*';
  }
  const pattern=actual==='wayward' ? /^\d{4}-\d{2}-\d{2}(?:-[a-z][a-z0-9.]*)?$/ : /^\d+(?:\.\d+)*$/;
  if(versions.some(version=>!pattern.test(version.trim()))) throw new Error('게임 버전은 비교 기호 없이 버전만 입력해 주세요.');
  const spec=versions.length ? versions.map(version=>actual==='wayward' ? version.trim() : actual+'-'+version.trim()).join(' || ') : actual==='wayward' ? '' : actual;
  if(spec && parseGameRequirement(spec).gameFamily!==actual) throw new Error('선택한 게임에 맞는 버전을 입력해 주세요.');
  return spec;
}
export function wikiGameFields(spec) {
  const raw=typeof spec==='string' ? spec.trim() : '';
  const family=raw ? parseGameRequirement(raw).gameFamily : 'wayward';
  const fields={family:GAME_FAMILIES.includes(family) ? family : '__other',other:GAME_FAMILIES.includes(family) ? '' : family,versions:[],complex:false};
  if(!raw || raw==='*' || raw===family) return fields;
  const escaped=family.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const parts=raw.split(/\s*\|\|\s*/);
  for(const part of parts) {
    const match=family==='wayward'
      ? /^=?(\d{4}-\d{2}-\d{2}(?:-[a-z][a-z0-9.]*)?)$/.exec(part)
      : new RegExp('^'+escaped+'=-?(\\d+(?:\\.\\d+)*)$').exec(part) || new RegExp('^=?'+escaped+'-(\\d+(?:\\.\\d+)*)$').exec(part);
    if(!match) {fields.versions=[];fields.complex=true;break;}
    fields.versions.push(match[1]);
  }
  return fields;
}
const wmlList = value => {
  const versions=value.trim() ? value.split(',').map(part=>part.trim()) : [];
  if (versions.length>20 || versions.some(version=>!version) || new Set(versions).size!==versions.length) throw new Error('WML 버전은 중복 없이 최대 20개까지 쉼표로 구분해 주세요.');
  versions.forEach(version=>compareVersions(version,'0.0.0'));
  return versions;
};

export function wikiRow(value) {
  if(!value || typeof value!=='object') return null;
  const row={mod_id:text(value.mod_id,64),post_url:text(value.post_url,2048),version:text(value.version,64),wml_versions:[],game_spec:text(value.game_spec,256),name:text(value.name,100)||text(value.mod_id,64)||'이름 없음',category:text(value.category,80)||'미분류',description:text(value.description,4000)||'설명 미등록',api_version:['1','2'].includes(String(value.api_version))?String(value.api_version):null,revision:value.revision,package_sha256:value.package_sha256 ?? null};
  try {
    validateModId(row.mod_id); row.validId=true;
    row.post_url=validatePostURL(row.post_url);
    compareVersions(row.version,'0.0.0');
    if(!Array.isArray(value.wml_versions)) throw new Error('WML 버전 정보 오류');
    row.wml_versions=wmlList(value.wml_versions.join(','));
    if(row.game_spec) parseGameRequirement(row.game_spec);
    if(value.game_family!==undefined && value.game_family!==wikiGameFamily(row)) throw new Error('게임 계열 정보 오류');
    if(row.package_sha256!==null && (typeof row.package_sha256!=='string' || !/^[a-f0-9]{64}$/.test(row.package_sha256))) throw new Error('ZIP 해시 정보 오류');
    row.valid=true;
  } catch { row.valid=false; }
  return row;
}

export function wikiInstallCompatibility(row,pkg,game) {
  const compatibility=evaluateCompatibility(pkg,game.wmlVersion,game.gameVersion);
  if(compatibility.gameState==='unsupported' || compatibility.state==='unsupported') throw new Error('이 모드는 현재 게임 또는 WML 버전과 호환되지 않습니다.');
  if(!gameMatches(row.game_spec || 'wayward',game.gameVersion)) throw new Error('위키에 등록된 게임 호환 조건이 현재 게임과 맞지 않습니다.');
  if(row.wml_versions.length && !row.wml_versions.includes(game.wmlVersion)) throw new Error('위키에 등록된 WML 호환 버전이 현재 버전과 맞지 않습니다.');
  return compatibility;
}

export async function inspectWikiRelease({modId,postURL,message,askPassword,getPassword}) {
  validateModId(modId); validatePostURL(postURL);
  if(!await askPassword()) throw new Error('비밀번호 설정을 취소했습니다.');
  let diagnostic=(await message({type:'DIAGNOSE_POST',modId,postURL})).diagnostic;
  if(diagnostic?.checks?.some(check=>check.id==='collection_files' && check.status==='warning') && await askPassword(true)) diagnostic=(await message({type:'DIAGNOSE_POST',modId,postURL})).diagnostic;
  const problem=diagnostic?.checks?.find(check=>check.status==='error' || check.status==='blocked');
  const files=diagnostic?.checks?.find(check=>check.id==='collection_files');
  if(!diagnostic?.ok || problem || files?.status!=='pass' || !diagnostic.release?.version || !diagnostic.release?.fileName) throw new Error(problem?.feedback || files?.feedback || '게시글과 Kio 파일 진단을 통과하지 못했습니다.');
  const found=diagnostic.release;
  validateReleaseURL(found.url); compareVersions(found.version,'0.0.0');
  if(found.modId!==modId || found.postURL!==postURL) throw new Error('진단한 모드 또는 게시글이 변경됐습니다.');
  const bytes=await downloadRelease({modId,url:found.url,version:found.version,fileName:found.fileName,password:getPassword()});
  await scanDownloadedZip(bytes);
  const pkg=await inspectPackage(bytes,found.version,modId);
  return {found,pkg,bytes};
}

export function initWikiUI({message,askPassword,getPassword,getGame,isBusy,setBusy}) {
  const $=id=>document.getElementById(id);
  let rows=[],selected=null,diagnosed=null,loaded=false,loading=false,revisionTarget=null;
  let originalGameSpec=null,gameVersions=[];
  const rowKey=row=>wikiGameFamily(row)+'/'+row.mod_id;
  const gameFields=()=>({family:$('wiki-form-family').value,other:$('wiki-form-other').value,versions:[...gameVersions]});
  const renderGameVersions=()=>{
    const list=$('wiki-game-versions');list.replaceChildren();
    for(const version of gameVersions) {
      const item=document.createElement('li'),button=document.createElement('button');
      item.append(document.createTextNode(version+' '));button.type='button';button.textContent='삭제';button.setAttribute('aria-label',version+' 삭제');
      button.onclick=()=>{gameVersions=gameVersions.filter(value=>value!==version);originalGameSpec=null;$('wiki-form-game-existing').hidden=true;renderGameVersions();invalidate();};
      item.append(button);list.append(item);
    }
  };
  const syncGameControls=()=>{
    const family=$('wiki-form-family').value;
    $('wiki-form-other-wrap').hidden=family!=='__other';
    $('wiki-form-game').disabled=family==='any';
    $('wiki-game-add').disabled=family==='any';
  };
  const setGameSpec=spec=>{
    const fields=wikiGameFields(spec);
    $('wiki-form-family').value=fields.family;$('wiki-form-other').value=fields.other;
    $('wiki-form-game').value='';gameVersions=[...fields.versions];
    syncGameControls();renderGameVersions();
    originalGameSpec={value:spec,signature:JSON.stringify(gameFields())};
    $('wiki-form-game-existing').hidden=!fields.complex;
    $('wiki-form-game-existing').textContent=fields.complex ? `기존 복합 버전 조건: ${spec} · 게임이나 버전 항목을 변경하기 전까지 그대로 유지됩니다.` : '';
  };
  const selectedGameSpec=()=>{
    const fields=gameFields();
    if($('wiki-form-game').value.trim()) throw new Error('입력한 게임 버전의 추가 버튼을 눌러 주세요.');
    if(originalGameSpec && originalGameSpec.signature===JSON.stringify(fields)) return originalGameSpec.value;
    return wikiGameSpec(fields.family,fields.other,fields.versions);
  };
  const diagnostic=value=>{$('wiki-diagnostic-status').textContent=value;};
  const installStatus=value=>{$('wiki-install-status').textContent=value;};
  const invalidate=()=>{diagnosed=null;$('wiki-submit').disabled=true;};
  const formValue=()=>{
    const mod_id=validateModId($('wiki-form-id').value.trim()),post_url=validatePostURL($('wiki-form-post').value.trim());
    const name=text($('wiki-form-name').value,100),category=text($('wiki-form-category').value==='기타' ? ($('wiki-form-category-custom').value || '기타') : $('wiki-form-category').value,80),description=text($('wiki-form-description').value,4000);
    const wml_versions=wmlList($('wiki-form-wml').value);
    let game_spec=selectedGameSpec();
    if(!wml_versions.length && !game_spec) game_spec='wayward';
    if(game_spec.length>128) throw new Error('게임 호환 범위는 128자 이내로 입력해 주세요.');
    if(game_spec) parseGameRequirement(game_spec);
    if(!name || !category || !description) throw new Error('모드 이름, 카테고리와 설명을 입력해 주세요.');
    if(category.length>60 || [name,category,description].some(value=>/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))) throw new Error('카테고리는 60자 이내로 입력하고 사용할 수 없는 제어 문자를 제거해 주세요.');
    const kind=$('wiki-form-kind').value;
    if(!['create','revision'].includes(kind)) throw new Error('신청 종류가 올바르지 않습니다.');
    if(kind==='revision' && (!rows.some(row=>row.mod_id===mod_id && wikiGameFamily(row)===wikiGameFamily({game_spec})) || revisionTarget && revisionTarget!==wikiGameFamily({game_spec})+'/'+mod_id)) throw new Error('수정 신청은 선택한 모드의 게임 계열과 ID를 유지해 주세요.');
    return {kind,payload:{mod_id,name,post_url,wml_versions,game_spec,game_family:wikiGameFamily({game_spec}),description,category}};
  };
  const render=()=>{
    const query=$('wiki-search').value.trim().normalize('NFKC').toLocaleLowerCase();
    const filter=$('wiki-game-filter').value;
    const matches=rows.filter(row=>{
      const family=wikiGameFamily(row);
      const inFamily=!filter || (filter==='__other' ? !['wayward','faith','overtime','any','__unknown'].includes(family) : family===filter);
      return inFamily && `${row.name} ${row.mod_id} ${row.category} ${row.game_spec} ${wikiGameLabel(family)}`.normalize('NFKC').toLocaleLowerCase().includes(query);
    });
    $('wiki-list').replaceChildren();
    for(const row of matches) {
      const item=document.createElement('li'),button=document.createElement('button'),title=document.createElement('strong'),detail=document.createElement('span');
      button.type='button';button.setAttribute('aria-pressed',String(!!selected && rowKey(selected)===rowKey(row)));
      title.textContent=row.name;detail.className='ready-detail';detail.textContent=`${row.mod_id} · ${row.version} · ${row.category} · ${wikiGameLabel(wikiGameFamily(row))}${row.valid ? '' : ' · 정보 확인 필요'}`;
      button.append(title,detail);button.onclick=()=>select(row);item.append(button);$('wiki-list').append(item);
    }
    $('wiki-list-status').textContent=matches.length ? `${matches.length}개 모드` : query || filter ? '해당 조건의 모드가 없습니다. 게임 계열이나 검색어를 바꿔 보세요.' : '아직 승인된 모드가 없습니다.';
  };
  const select=row=>{
    selected=row;render();$('wiki-detail').hidden=false;
    $('wiki-detail-title').textContent=row.name;
    $('wiki-detail-meta').textContent=`${row.mod_id} · ${row.version} · ${row.category} · ${wikiGameLabel(wikiGameFamily(row))}`;
    $('wiki-detail-description').textContent=row.description;
    $('wiki-detail-compatibility').textContent=`WML: ${row.wml_versions.length ? row.wml_versions.join(', ') : '미확인'} · 게임: ${row.game_spec || '일반 Wayward (버전 미지정)'}`;
    const post=$('wiki-post');post.hidden=!row.valid;if(row.valid) post.href=row.post_url;else post.removeAttribute('href');
    $('wiki-revise').disabled=!row.validId;
    const game=getGame(),active=!!row.valid && !!game && gameMatches(row.game_spec || 'wayward',game.gameVersion) && !!game.mods?.some(mod=>mod.modId===row.mod_id);
    $('wiki-install').disabled=!row.valid || active;
    installStatus(!row.valid ? '등록된 정보에 오류가 있어 설치와 게시글 연결을 사용할 수 없습니다. 관리자에게 수정을 요청해 주세요.' : active ? '이 모드는 현재 활성 상태입니다. 모드 업데이트 탭을 이용하세요.' : '');
  };
  async function load(force=false) {
    if(loading || loaded && !force) return;
    loading=true;$('wiki-list-status').textContent='승인된 모드 목록을 불러오고 있습니다.';
    try {
      rows=(await listWikiMods()).map(wikiRow).filter(Boolean);loaded=true;
      const replacement=selected && rows.find(row=>rowKey(row)===rowKey(selected));
      if(replacement) select(replacement); else {selected=null;$('wiki-detail').hidden=true;render();}
    } catch(error) {$('wiki-list-status').textContent=`위키 목록을 불러오지 못했습니다: ${error.message}`;}
    finally{loading=false;}
  }
  function setGame(game) {
    const selectMod=$('wiki-form-mod'),previous=selectMod.value;
    selectMod.replaceChildren(new Option('직접 입력',''));
    for(const mod of game?.mods || []) selectMod.add(new Option(`${mod.modNameKo || mod.modName || mod.modId} · ${mod.modId}`,mod.modId));
    if([...selectMod.options].some(option=>option.value===previous)) selectMod.value=previous;
    if(selected) select(selected);
  }
  $('wiki-search').oninput=render;
  $('wiki-game-filter').onchange=render;
  $('wiki-refresh').onclick=()=>void load(true);
  $('wiki-form').addEventListener('input',invalidate);
  $('wiki-form-kind').addEventListener('change',()=>{if($('wiki-form-kind').value!=='revision') revisionTarget=null;});
  for(const id of ['wiki-form-family','wiki-form-other']) {
    $(id).addEventListener('input',()=>{originalGameSpec=null;gameVersions=[];$('wiki-form-game').value='';$('wiki-form-game-existing').hidden=true;renderGameVersions();syncGameControls();});
  }
  $('wiki-game-add').onclick=()=>{
    const version=$('wiki-form-game').value.trim();
    try {
      const fields=gameFields();wikiGameSpec(fields.family,fields.other,[...fields.versions,version]);
      gameVersions.push(version);$('wiki-form-game').value='';originalGameSpec=null;$('wiki-form-game-existing').hidden=true;renderGameVersions();invalidate();diagnostic('게임 버전을 추가했습니다.');
    } catch(error) {diagnostic(error.message);}
  };
  $('wiki-form-game').onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();$('wiki-game-add').click();}};
  syncGameControls();
  $('wiki-form-category').onchange=()=>{$('wiki-custom-category').hidden=$('wiki-form-category').value!=='기타';invalidate();};
  $('wiki-form-mod').onchange=()=>{
    const game=getGame(),mod=game?.mods?.find(item=>item.modId===$('wiki-form-mod').value);
    if(!mod) return;
    $('wiki-form-id').value=mod.modId;$('wiki-form-name').value=mod.modNameKo || mod.modName || mod.modId;
    $('wiki-form-post').value=mod.apiPostURL || mod.postURL || '';
    try {const family=parseGameVersion(game.gameVersion).gameFamily;setGameSpec(family==='wayward' ? '' : family);} catch {}
    invalidate();diagnostic('호환 정보와 설명을 입력한 뒤 진단해 주세요.');
  };
  $('wiki-revise').onclick=()=>{
    if(!selected) return;
    revisionTarget=rowKey(selected);
    $('wiki-form-kind').value='revision';$('wiki-form-mod').value='';
    for(const [id,value] of [['id',selected.mod_id],['name',selected.name],['post',selected.post_url],['wml',selected.wml_versions.join(', ')],['description',selected.description]]) $(`wiki-form-${id}`).value=value;
    setGameSpec(selected.game_spec);
    const preset=[...$('wiki-form-category').options].some(option=>option.value===selected.category);
    $('wiki-form-category').value=preset ? selected.category : '기타';
    $('wiki-form-category-custom').value=preset ? '' : selected.category;
    $('wiki-custom-category').hidden=$('wiki-form-category').value!=='기타';
    invalidate();diagnostic('수정 내용을 입력하고 게시글·ZIP을 다시 진단해 주세요.');
    $('wiki-application-title').scrollIntoView({block:'start'});$('wiki-form-name').focus();
  };
  $('wiki-diagnose').onclick=async()=>{
    if(isBusy()) return;
    invalidate(); let input;
    try { if(!$('wiki-form').reportValidity()) return; input=formValue(); }
    catch(error){diagnostic(error.message);return;}
    const signature=JSON.stringify(input);setBusy(true);diagnostic('게시글, Kio 파일과 ZIP 내용을 검사하고 있습니다.');
    try {
      const {pkg}=await inspectWikiRelease({modId:input.payload.mod_id,postURL:input.payload.post_url,message,askPassword,getPassword});
      if(JSON.stringify(formValue())!==signature) throw new Error('입력 내용이 바뀌었습니다. 다시 진단해 주세요.');
      const notes=[];
      const declared=pkg.gameSpec || '*',declaredFamily=parseGameRequirement(declared).gameFamily,chosenFamily=wikiGameFamily({game_spec:input.payload.game_spec});
      if(declaredFamily!=='any' && declaredFamily!==chosenFamily) throw new Error(`선택한 게임과 ZIP의 게임 계열(${wikiGameLabel(declaredFamily)})이 다릅니다.`);
      const originalComplex=!!(originalGameSpec && wikiGameFields(originalGameSpec.value).complex);
      const hasVersion=gameVersions.length>0 || originalComplex;
      if(originalComplex && input.payload.game_spec!==declared) throw new Error(`기존 버전 조건이 ZIP 선언(${declared})과 다릅니다. 모드 헤더 또는 입력 내용을 수정해 주세요.`);
      const invalidVersions=gameVersions.filter(version=>!gameMatches(declared,chosenFamily==='wayward' ? version : chosenFamily+'-'+version));
      if(invalidVersions.length) throw new Error(`선택한 게임 버전(${invalidVersions.join(', ')})은 ZIP 선언(${declared})과 호환되지 않습니다.`);
      if(pkg.supportedWml && input.payload.wml_versions.length && [...input.payload.wml_versions].sort().join(',')!==[...pkg.supportedWml].sort().join(',')) throw new Error(`입력한 WML 버전이 ZIP 선언(${pkg.supportedWml.join(', ')})과 다릅니다. 모드 헤더 또는 입력 내용을 수정해 주세요.`);
      if(!pkg.supportedWml) notes.push('ZIP에 WML 호환 선언이 없어 입력 내용은 미확인입니다.');
      const game=getGame(),protocol=game?.api?.[input.payload.mod_id]?.protocol;
      const game_spec=!hasVersion && declaredFamily===chosenFamily && declared!=='*' ? declared : input.payload.game_spec;
      diagnosed={...input,payload:{...input.payload,game_spec,version:pkg.version,api_version:[1,2].includes(protocol)?String(protocol):null},signature};
      $('wiki-submit').disabled=false;
      diagnostic(`게시글·Kio·ZIP ID/버전 검사 통과 · ${pkg.version} · 게임: ${wikiGameLabel(wikiGameFamily({game_spec}))}${game_spec ? ' ('+game_spec+')' : ''}${notes.length ? '\n'+notes.join('\n') : ''}`);
    } catch(error){diagnostic(`진단 실패: ${error.message}`);}
    finally{setBusy(false);}
  };
  $('wiki-form').onsubmit=async event=>{
    event.preventDefault();if(isBusy() || !diagnosed) return;
    try { if(JSON.stringify(formValue())!==diagnosed.signature) throw new Error('입력 내용이 바뀌었습니다. 다시 진단해 주세요.'); }
    catch(error){invalidate();diagnostic(error.message);return;}
    const submission=diagnosed;invalidate();setBusy(true);diagnostic('위키 신청을 보내고 있습니다.');
    try {
      const result=await submitWikiMod(submission.kind,submission.payload,'manual');
      if(!result?.ok) throw new Error('신청 결과를 확인하지 못했습니다.');
      const published=['published','approved'].includes(result.status);
      diagnostic(published ? '위키에 등록됐습니다.' : `신청이 접수됐습니다. 관리자 검토를 기다려 주세요.${result.id ? ' 접수 번호: '+result.id : ''}`);
      if(published) await load(true);
    } catch(error){diagnostic(error.code==='SUBMISSION_UNKNOWN' ? error.message : `신청 실패: ${error.message} 다시 진단한 뒤 신청해 주세요.`);}
    finally{setBusy(false);}
  };
  $('wiki-install').onclick=async()=>{
    const row=selected,game=getGame();
    if(isBusy() || !row?.valid) return;
    if(!game){installStatus('먼저 게임을 실행하고 도우미를 연결해 주세요.');return;}
    if(!gameMatches(row.game_spec || 'wayward',game.gameVersion)){installStatus('이 모드는 현재 게임 계열 또는 게임 버전과 호환되지 않습니다.');return;}
    if(game.mods?.some(mod=>mod.modId===row.mod_id)){installStatus('이미 활성화된 모드입니다. 모드 업데이트 탭을 이용하세요.');return;}
    setBusy(true);let root;
    try {
      root=await connectNativeGameFolder(game.url);
      await ensureNewFolder(root,row.mod_id);
      installStatus('게시글·Kio·ZIP을 다시 확인하고 있습니다.');
      const checked=await inspectWikiRelease({modId:row.mod_id,postURL:row.post_url,message,askPassword,getPassword});
      const comparison=compareVersions(checked.pkg.version,row.version);
      if(comparison<0) throw new Error(`승인된 ${row.version}보다 오래된 ZIP만 발견됐습니다. 게시글을 확인해 주세요.`);
      let verification='승인 시 서버 ZIP 해시가 없어 같은 파일인지 확인할 수 없습니다.';
      if(comparison>0) verification=`현재 ZIP ${checked.pkg.version}은 위키 승인 버전 ${row.version}보다 새 버전으로, 해당 ZIP은 위키에서 검토되지 않았습니다.`;
      else if(row.package_sha256) {
        const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',checked.bytes))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
        if(digest!==row.package_sha256) throw new Error('다운로드한 ZIP이 승인된 파일의 SHA-256과 다릅니다. 설치를 중단합니다.');
        verification='승인된 ZIP의 SHA-256이 일치합니다.';
      }
      const compatibility=wikiInstallCompatibility(row,checked.pkg,game);
      const warning=compatibility.state==='unknown' ? '\nWML 호환 정보가 없어 실제 호환 여부를 확인할 수 없습니다.' : '';
      if(!confirm(`${row.name} (${row.mod_id}) ${checked.pkg.version}\n설치 경로: ${root.path}\\wml\\mods\\${row.mod_id}\n${verification}\n게임을 저장한 뒤 설치해 주세요.${warning}\n\n다운로드한 모드를 설치할까요?`)){installStatus('설치를 취소했습니다.');return;}
      if(!navigator.locks) throw new Error('동시 업데이트 보호 기능을 사용할 수 없습니다.');
      await navigator.locks.request('wml-mod-updater-install',{ifAvailable:true},async lock=>{
        if(!lock) throw new Error('다른 모드·게임 업데이트가 진행 중입니다.');
        const fresh=(await message({type:'GET_GAME',tabId:game.tabId})).game;
        if(!fresh || fresh.documentId!==game.documentId || fresh.url!==game.url || fresh.gameVersion!==game.gameVersion || fresh.wmlVersion!==game.wmlVersion || fresh.mods.some(mod=>mod.modId===row.mod_id)) throw new Error('게임 또는 모드 상태가 바뀌었습니다. 다시 확인해 주세요.');
        installStatus('선택한 모드를 설치하고 있습니다.');
        await installNewMod(root,checked.bytes,{modId:row.mod_id,expectedVersion:checked.pkg.version,gameFile:root.gameFile,expectedGame:{gameVersion:game.gameVersion,wmlVersion:game.wmlVersion,htmlVersion:game.htmlVersion},allowUnknownWml:compatibility.state==='unknown'});
      });
      installStatus(`설치 완료: ${row.mod_id} ${checked.pkg.version}. 게임을 저장하고 종료한 뒤 게임 폴더의 wml\\mods\\모드목록_자동갱신.cmd 또는 update-mod-list.cmd를 실행하세요. 이후 게임을 다시 열어 모드를 활성화하세요.`);
    } catch(error){installStatus(`설치하지 못했습니다: ${error.message}`);}
    finally{root?.disconnect();setBusy(false);}
  };
  $('wiki-auto-consent').onchange=async()=>{
    const checkbox=$('wiki-auto-consent');checkbox.disabled=true;
    try {
      await chrome.storage.local.set({wikiAutoSubmit:checkbox.checked});
      $('wiki-auto-status').textContent=checkbox.checked ? '자동 신청을 허용했습니다. 연결된 API 모드를 검사합니다.' : '자동 신청을 사용하지 않습니다.';
    } catch(error){checkbox.checked=!checkbox.checked;$('wiki-auto-status').textContent=`자동 신청 설정을 저장하지 못했습니다: ${error.message}`;checkbox.disabled=false;return;}
    try { if(checkbox.checked && getGame()) await message({type:'SCAN_WIKI_CANDIDATES',tabId:getGame().tabId,documentId:getGame().documentId}); }
    catch(error){$('wiki-auto-status').textContent=`설정은 저장됐지만 이번 검사는 시작하지 못했습니다: ${error.message}`;}
    finally{checkbox.disabled=false;}
  };
  const showAuto=items=>{
    const labels={submitted:'신청됨',pending:'관리자 검토 중',published:'위키 등록됨',unknown:'접수 여부를 관리자에게 확인해 주세요',diagnostic_failed:'게시글 진단 실패',archive_failed:'ZIP 검사 실패',error:'연결 또는 신청 오류'};
    if(!Array.isArray(items) || !items.length) return;
    $('wiki-auto-status').textContent=items.slice(0,20).map(item=>`${text(item.modId,64)}: ${labels[item.status] || '상태 확인 필요'}`).join(' · ');
  };
  void chrome.storage?.local?.get(['wikiAutoSubmit','wikiAutoStatus']).then(saved=>{$('wiki-auto-consent').checked=saved.wikiAutoSubmit===true;showAuto(saved.wikiAutoStatus);}).catch(()=>{});
  chrome.storage?.onChanged?.addListener((changes,area)=>{if(area==='local' && changes.wikiAutoStatus) showAuto(changes.wikiAutoStatus.newValue);});
  return {load,setGame};
}
