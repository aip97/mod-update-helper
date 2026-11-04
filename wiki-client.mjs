const BASE = 'https://bxcptogtnylktxodiqyn.supabase.co';
const KEY = 'sb_publishable_pFa1oDfDdZINcU6XzYlqFw_nyw9CbtU';
const fields = 'game_family,mod_id,name,post_url,wml_versions,game_spec,description,category,version,api_version,revision,package_sha256';

async function request(path, options = {}, timeout = 15000) {
  let response;
  try { response = await fetch(BASE + path, {
    ...options, credentials:'omit', referrerPolicy:'no-referrer', cache:'no-store',
    signal:AbortSignal.timeout(timeout), headers:{apikey:KEY, ...options.headers},
  }); } catch(error) {
    if(options.method==='POST') throw Object.assign(new Error('응답을 확인하지 못했습니다. 중복 신청 전 관리자에게 접수 여부를 확인해 주세요.'),{code:'SUBMISSION_UNKNOWN'});
    throw error;
  }
  if (!response.ok) {
    if(options.method==='POST' && response.status>=500) throw Object.assign(new Error('서버 응답이 불확실합니다. 중복 신청 전 관리자에게 접수 여부를 확인해 주세요.'),{code:'SUBMISSION_UNKNOWN'});
    let detail='';
    try { const body=await response.json(); if(typeof body?.error==='string') detail=body.error.slice(0,500); } catch {}
    throw new Error(detail || `위키 연결에 실패했습니다. (${response.status})`);
  }
  let value;
  try { value=await response.json(); }
  catch(error) {
    if(options.method==='POST') throw Object.assign(new Error('신청 응답을 확인하지 못했습니다. 중복 신청 전 관리자에게 접수 여부를 확인해 주세요.'),{code:'SUBMISSION_UNKNOWN'});
    throw error;
  }
  if (value?.ok === false) throw new Error(value.error || '위키 요청이 거부됐습니다.');
  return value;
}

export async function listWikiMods() {
  const rows=[];
  for (let offset=0; offset<10000; offset+=500) {
    const page=await request(`/rest/v1/wiki_mods?select=${fields}&order=mod_id.asc,game_family.asc&limit=500&offset=${offset}`);
    if (!Array.isArray(page)) throw new Error('위키 목록 형식이 올바르지 않습니다.');
    rows.push(...page);
    if (page.length<500) return rows;
  }
  throw new Error('위키 목록이 너무 큽니다. 나중에 다시 시도해 주세요.');
}

export async function getWikiSources() {
  const rows=[];
  for(let offset=0;offset<10000;offset+=500) {
    const page=await request(`/rest/v1/wiki_mods?select=game_family,mod_id,post_url,game_spec,wml_versions&order=mod_id.asc,game_family.asc&limit=500&offset=${offset}`);
    if(!Array.isArray(page)) throw new Error('위키 목록 형식이 올바르지 않습니다.');
    rows.push(...page);
    if(page.length<500) return rows;
  }
  throw new Error('위키 목록이 너무 큽니다. 나중에 다시 시도해 주세요.');
}

export function submitWikiMod(kind, payload, source = 'manual') {
  return request('/functions/v1/wiki-registration-v1', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind,payload,source})},150000);
}
