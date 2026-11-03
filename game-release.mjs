import {validateGameUpdateAPI, parseReleaseHTML} from './core.mjs';
import {parseGameVersion, compareGameVersions} from './game-compat.mjs';
import {listKioFiles} from './kio-api.mjs';

const defaults = {faith: {
  protocol:1, postURL:'https://kone.gg/s/wayward-wml/ctRTv4mPI2NMv8JcYdlQeb',
  packages:[
    {id:'full',label:'전체판',file:'Wayward_Faith_v{version}.zip',html:'Wayward_Faith_v{version}.html'},
    {id:'nosound',label:'경량판 (소리 제외)',file:'Wayward_Faith_NoSound_v{version}.zip',html:'Wayward_Faith_v{version}.html'},
  ],
}, overtime: {
  protocol:1, postURL:'https://kone.gg/s/wayward-wml/b2UDO8mj_hRKv3nmbHOAeb',
  packages:[
    {id:'full',label:'전체판',file:'Wayward_Overtime_v{version}.zip',html:'Wayward_Overtime_v{version}.html'},
    {id:'nosound',label:'경량판 (소리 제외)',file:'Wayward_Overtime_NoSound_v{version}.zip',html:'Wayward_Overtime_v{version}.html'},
  ],
}};
export function gameSource(game) {
  if (game?.gameUpdateError) throw new Error(game.gameUpdateError);
  const source = game?.gameUpdate || (Object.hasOwn(defaults,game?.gameFamily) ? defaults[game.gameFamily] : null);
  return source ? validateGameUpdateAPI(source) : null;
}
export function gameReleaseFromFiles(files, game, source, edition) {
  source = validateGameUpdateAPI(source);
  const spec = source.packages.find(item=>item.id===edition);
  if (!spec) throw new Error('선택한 게임 배포판을 확인할 수 없습니다.');
  const escape = value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const pattern = new RegExp('^'+spec.file.split('{version}').map(escape).join('([0-9][0-9a-z.-]{0,63})')+'$');
  const compact = value=>value.toLowerCase().replace(/[ _.-]/g,'');
  const versionless = files.filter(file=>typeof file.name==='string' && [spec.file.replace('{version}',''),spec.file.replace(/v?\{version\}/i,'')].some(name=>compact(name)===compact(file.name)));
  const fileHint = list=>list.slice(0,8).map(file=>`${String(file.name).replace(/[\x00-\x1f]/g,' ').slice(0,240)} · ${file.url || source.postURL}`).join('\n');
  const namingHelp = `파일명 규칙: ${spec.file}\n{version}을 실제 배포 버전으로 바꿔 ZIP 파일명에 넣어 주세요. 게시글 제목의 버전으로 대신할 수 없습니다.\nZIP 내부 HTML 예상 위치: <게임 폴더>/${spec.html}\n게시글: ${source.postURL}`;
  const candidates=[];
  for(const file of files) {
    const match=pattern.exec(file.name); if(!match) continue;
    const version=game.gameFamily==='wayward'?match[1]:game.gameFamily+'-'+match[1];
    try { if(parseGameVersion(version).gameFamily!==game.gameFamily) continue; } catch { continue; }
    if(!Number.isSafeInteger(file.size) || file.size<22 || file.size>512*1024*1024) throw new Error('게임 ZIP은 512 MiB 이내여야 합니다.');
    candidates.push({gameVersion:version,version:match[1],fileName:file.name,size:file.size,url:file.url,html:spec.html.replace('{version}',match[1]),edition:spec.id,label:spec.label,postURL:source.postURL,preserve:source.preserve});
  }
  candidates.sort((a,b)=>compareGameVersions(b.gameVersion,a.gameVersion));
  if(!candidates.length) throw new Error(`${versionless.length?'게임 ZIP 파일명에 버전이 없습니다.':'선택한 게임 배포판의 파일명 규칙과 일치하는 ZIP이 없습니다.'}\n${namingHelp}\n발견한 ZIP · 다운로드 컬렉션:\n${fileHint(versionless.length?versionless:files.filter(file=>/\.zip$/i.test(file.name))) || '(ZIP 없음)'}`);
  if(candidates[1]?.gameVersion===candidates[0].gameVersion) throw new Error('동일한 최신 게임 버전 ZIP이 중복되어 있습니다.');
  return {...candidates[0],filenameWarning:versionless.length?`버전 없는 ZIP은 새 버전 비교에서 제외했습니다. 더 최신 파일이라면 이름을 수정하세요.\n${namingHelp}\n발견한 ZIP · 다운로드 컬렉션:\n${fileHint(versionless)}`:''};
}
export async function findGameRelease({html,game,source,edition,password}) {
  source=validateGameUpdateAPI(source);
  const post=parseReleaseHTML(html,{modId:game.gameFamily,postURL:source.postURL});
  const files=[];
  for(const url of post.urls) for(const file of await listKioFiles({url,password})) files.push({...file,url});
  return {...gameReleaseFromFiles(files,game,source,edition),checkedAt:Date.now()};
}
