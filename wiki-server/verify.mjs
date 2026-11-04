import {validateModId, validatePostURL} from '../core.mjs';

export async function verifyPublicRelease(payload) {
  validateModId(payload.mod_id);
  validatePostURL(payload.post_url);
  // shortcut: Kone server-side collection is disabled until the service permits it.
  throw Object.assign(new Error('서버의 코네 자동 수집은 사용하지 않습니다. 관리자가 게시글과 파일을 직접 확인해야 합니다.'), {manualReview:true});
}

export function createPublicReleaseVerifier({enabled=false}={}) {
  if(enabled !== true) return verifyPublicRelease;
  return async payload => {
    validateModId(payload.mod_id);
    validatePostURL(payload.post_url);
    throw Object.assign(new Error('코네가 허용한 서버 인증 방식이 확인되지 않아 자동 검증을 시작할 수 없습니다. 관리자 확인이 필요합니다.'), {manualReview:true});
  };
}
