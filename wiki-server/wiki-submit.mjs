import {validateModId, validatePostURL, compareVersions} from '../core.mjs';
import {parseGameRequirement} from '../game-compat.mjs';
import {verifyPublicRelease} from './verify.mjs';

const ORIGIN='chrome-extension://dlddgdefgecebmfhjinfamnffjkgohao';
const json=(value,status=200) => new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json','access-control-allow-origin':ORIGIN,'access-control-allow-headers':'apikey, authorization, content-type','access-control-allow-methods':'POST, OPTIONS','cache-control':'no-store'}});
const need=(condition,message)=>{if(!condition) throw new Error(message);};
function validate(payload) {
  need(payload && typeof payload==='object' && !Array.isArray(payload),'신청 정보를 확인해 주세요.');
  validateModId(payload.mod_id); validatePostURL(payload.post_url); compareVersions(payload.version,'0.0.0');
  need(typeof payload.game_spec==='string' && payload.game_spec.length<=128,'게임 호환 정보를 확인해 주세요.');
  const gameFamily=payload.game_spec ? parseGameRequirement(payload.game_spec).gameFamily : 'wayward';
  need(payload.game_family == null || payload.game_family === gameFamily,'신청한 게임 종류와 호환 조건이 다릅니다.');
  for(const [key,max] of [['name',120],['description',5000],['category',60]]) need(typeof payload[key]==='string' && payload[key].trim().length>0 && payload[key].length<=max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(payload[key]),`${key} 항목을 확인해 주세요.`);
  need(Array.isArray(payload.wml_versions) && payload.wml_versions.length<=20,'WML 호환 버전을 확인해 주세요.');
  payload.wml_versions.forEach(value=>compareVersions(value,'0.0.0'));
  need(payload.game_spec || payload.wml_versions.length>0,'WML 또는 게임 호환 정보를 하나 이상 입력해 주세요.');
  need(new Set(payload.wml_versions).size===payload.wml_versions.length,'WML 버전이 중복됐습니다.');
  need(payload.api_version==null || typeof payload.api_version==='string' && /^[A-Za-z0-9._-]{1,32}$/.test(payload.api_version),'API 버전이 올바르지 않습니다.');
  const clean=Object.fromEntries(['mod_id','name','post_url','wml_versions','game_spec','description','category','version','api_version'].map(key=>[key,payload[key]??null]));
  if(payload.game_family != null) clean.game_family=gameFamily;
  return clean;
}

async function bodyOf(request) {
  const announced=request.headers.get('content-length');
  if(announced && (!/^\d+$/.test(announced) || Number(announced)>16384)) throw new Error('신청 데이터가 너무 큽니다.');
  if(!request.body) throw new Error('신청 데이터가 없습니다.');
  const reader=request.body.getReader(), chunks=[];let size=0;
  try {for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>16384)throw new Error('신청 데이터가 너무 큽니다.');chunks.push(value);}}
  finally {await reader.cancel().catch(()=>{});}
  const bytes=new Uint8Array(size);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.length;}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}
async function hmac(key, value) {
  const bytes=new TextEncoder();
  const secret=await crypto.subtle.importKey('raw',bytes.encode(key),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',secret,bytes.encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
}
export function createHandler({url,key,publishableKeys=[],fetcher=fetch,verify=verifyPublicRelease}={}) {
  async function rpc(name,args) {
    const response=await fetcher(`${url}/rest/v1/rpc/${name}`,{method:'POST',headers:{apikey:key,'content-type':'application/json'},body:JSON.stringify(args),signal:AbortSignal.timeout(15000)});
    if(!response.ok) {
      let error={};try {error=await response.json();}catch {}
      const code=String(error.message||'');
      if(code.includes('WIKI_ALREADY_PUBLISHED')) throw new Error('이미 위키에 등록된 모드입니다. 수정 신청을 이용해 주세요.');
      if(code.includes('WIKI_QUEUE_FULL')) throw new Error('관리자 검토 대기열이 가득 찼습니다. 잠시 후 다시 시도해 주세요.');
      if(code.includes('WIKI_RATE_LIMIT')) throw new Error('신청 횟수 제한에 도달했습니다. 나중에 다시 시도해 주세요.');
      if(error.code==='23505') throw new Error('이 모드는 이미 검토 대기 중입니다.');
      throw new Error('신청 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.');
    }
    return response.json();
  }
  return async request=>{
    if(request.method==='OPTIONS') return new Response(null,{status:204,headers:{'access-control-allow-origin':ORIGIN,'access-control-allow-headers':'apikey, authorization, content-type','access-control-allow-methods':'POST, OPTIONS'}});
    if(request.method!=='POST') return json({ok:false,error:'지원하지 않는 요청입니다.'},405);
    if(!publishableKeys.some(value=>typeof value==='string' && value.startsWith('sb_publishable_') && value===request.headers.get('apikey'))) return json({ok:false,error:'요청 인증을 확인할 수 없습니다.'},401);
    try {
      need(typeof url==='string' && /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url) && typeof key==='string' && key.length>20,'서버 설정이 준비되지 않았습니다.');
      const body=await bodyOf(request), payload=validate(body.payload);
      need(['create','revision'].includes(body.kind) && ['manual','detected'].includes(body.source),'신청 유형을 확인해 주세요.');
      const address=request.headers.get('cf-connecting-ip');
      need(typeof address==='string' && address.length<=45 && /^[a-fA-F0-9:.]+$/.test(address),'요청 출처를 확인할 수 없습니다.');
      const rateKey=await hmac(key,'wiki-submission:'+address);
      await rpc('wiki_reserve_quota',{p_rate_key:rateKey});
      let verification='server_verified',apiVerified=false,reason='',verified;
      try { verified=await verify(payload,{fetcher}); apiVerified=verified.apiVerified; }
      catch(error) {if(!error.manualReview) throw error;verification='manual_review';reason=error.message;}
      const detected=body.source==='detected' && apiVerified && verification==='server_verified';
      const trustedPayload=detected
        ? {...payload,name:verified.name,description:'설명 미등록',category:'미분류',version:verified.version,wml_versions:verified.wmlVersions,game_spec:verified.gameSpec,api_version:verified.apiVersion} : payload;
      const saved=await rpc('wiki_create_submission',{p_payload:trustedPayload,p_kind:body.kind,p_source:detected?'detected':'manual',p_verification:verification,p_api_verified:apiVerified,p_package_sha256:verified?.packageSha256||null,p_rate_key:rateKey});
      need(saved && typeof saved.id==='string','신청 결과를 확인할 수 없습니다.');
      let status=saved.status;
      if(detected && body.kind==='create') {
        try {
          const published=await rpc('wiki_auto_publish',{p_submission_id:saved.id});
          if(published?.status) status=published.status;
        } catch {reason='자동 공개 조건을 확인할 수 없어 관리자 승인 대기로 접수됐습니다.';}
      }
      return json({ok:true,id:saved.id,status,revision:saved.revision,verification,...(reason?{reason}:{})});
    } catch(error) {return json({ok:false,error:String(error.message||'신청을 처리하지 못했습니다.').slice(0,300)},400);}
  };
}
