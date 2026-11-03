import {validateGameUpdateAPI, parseReleaseHTML} from './core.mjs';
import {parseGameVersion, compareGameVersions} from './game-compat.mjs';
import {listKioFiles} from './kio-api.mjs';

const faith = {
  protocol:1, postURL:'https://kone.gg/s/wayward-wml/ctRTv4mPI2NMv8JcYdlQeb',
  packages:[
    {id:'full',label:'전체판',file:'Wayward_Faith_v{version}.zip',html:'Wayward_Faith_v{version}.html'},
    {id:'nosound',label:'경량판 (소리 제외)',file:'Wayward_Faith_NoSound_v{version}.zip',html:'Wayward_Faith_v{version}.html'},
  ],
};
export function gameSource(game) {
  if (game?.gameUpdateError) throw new Error(game.gameUpdateError);
  return game?.gameUpdate ? validateGameUpdateAPI(game.gameUpdate) : game?.gameFamily === 'faith' ? validateGameUpdateAPI(faith) : null;
}
export function gameReleaseFromFiles(files, game, source, edition) {
  source = validateGameUpdateAPI(source);
  const spec = source.packages.find(item=>item.id===edition);
  if (!spec) throw new Error('선택한 게임 배포판을 확인할 수 없습니다.');
  const escape = value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const pattern = new RegExp('^'+spec.file.split('{version}').map(escape).join('([0-9][0-9a-z.-]{0,63})')+'$');
  const candidates=[];
  for(const file of files) {
    const match=pattern.exec(file.name); if(!match) continue;
    const version=game.gameFamily==='wayward'?match[1]:game.gameFamily+'-'+match[1];
    try { if(parseGameVersion(version).gameFamily!==game.gameFamily) continue; } catch { continue; }
    if(!Number.isSafeInteger(file.size) || file.size<22 || file.size>512*1024*1024) throw new Error('게임 ZIP은 512 MiB 이내여야 합니다.');
    candidates.push({gameVersion:version,version:match[1],fileName:file.name,size:file.size,url:file.url,html:spec.html.replace('{version}',match[1]),edition:spec.id,label:spec.label,postURL:source.postURL,preserve:source.preserve});
  }
  candidates.sort((a,b)=>compareGameVersions(b.gameVersion,a.gameVersion));
  if(!candidates.length) throw new Error(`선택한 게임 배포판 파일이 없습니다: ${spec.file}`);
  if(candidates[1]?.gameVersion===candidates[0].gameVersion) throw new Error('동일한 최신 게임 버전 ZIP이 중복되어 있습니다.');
  return candidates[0];
}
export async function findGameRelease({html,game,source,edition,password}) {
  source=validateGameUpdateAPI(source);
  const post=parseReleaseHTML(html,{modId:game.gameFamily,postURL:source.postURL});
  const files=[];
  for(const url of post.urls) for(const file of await listKioFiles({url,password})) files.push({...file,url});
  return {...gameReleaseFromFiles(files,game,source,edition),checkedAt:Date.now()};
}
