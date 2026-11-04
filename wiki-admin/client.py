import json
import urllib.error
import urllib.request


class WikiError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        raise WikiError('서버가 요청을 다른 주소로 이동하려 했습니다. 연결을 중단했습니다.')


class WikiClient:
    BASE = 'https://bxcptogtnylktxodiqyn.supabase.co'

    def __init__(self, public_key, opener=None):
        if not isinstance(public_key, str) or not public_key.startswith('sb_publishable_'):
            raise WikiError('공개 API 키가 없습니다. 관리자 도구 설정을 확인해 주세요.')
        self.public_key = public_key
        self.access_token = None
        self.refresh_token = None
        self.opener = opener or urllib.request.build_opener(NoRedirect())

    def request(self, path, payload=None, *, auth=True, _retry=True):
        headers = {'apikey': self.public_key, 'Accept': 'application/json'}
        if auth:
            if not self.access_token:
                raise WikiError('관리자 로그인이 필요합니다.')
            headers['Authorization'] = 'Bearer ' + self.access_token
        data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode('utf-8')
        if data is not None:
            headers['Content-Type'] = 'application/json'
        request = urllib.request.Request(self.BASE + path, data=data, headers=headers)
        try:
            with self.opener.open(request, timeout=20) as response:
                raw = response.read(2_000_001)
                if len(raw) > 2_000_000:
                    raise WikiError('서버 응답이 너무 큽니다.')
                return json.loads(raw.decode('utf-8')) if raw else None
        except urllib.error.HTTPError as error:
            if error.code == 401 and auth and _retry and self.refresh_token:
                try:
                    response = self.request('/auth/v1/token?grant_type=refresh_token',
                                            {'refresh_token': self.refresh_token}, auth=False)
                    self._set_session(response)
                except WikiError:
                    raise WikiError('로그인 갱신에 실패했습니다. 다시 로그인해 주세요. 작성 중인 내용은 유지됩니다.') from None
                return self.request(path, payload, auth=True, _retry=False)
            try:
                detail = json.loads(error.read(4096).decode('utf-8')).get('message')
            except (UnicodeError, ValueError, AttributeError):
                detail = None
            messages = {
                'WIKI_REVISION_CONFLICT': '다른 관리자가 먼저 변경했습니다. 목록을 새로고침해 주세요.',
                'WIKI_SUBMISSION_CLOSED': '이미 심사가 끝난 신청입니다. 목록을 새로고침해 주세요.',
                'WIKI_NOT_FOUND': '항목을 찾을 수 없습니다. 목록을 새로고침해 주세요.',
                'WIKI_ADMIN_REQUIRED': '이 계정에는 관리자 권한이 없습니다.',
                'WIKI_REVIEW_NOTE_REQUIRED': '직접 검증한 근거를 심사 메모에 입력해 주세요.',
                'WIKI_DIAGNOSTICS_REQUIRED': '게시글과 ZIP을 검증한 뒤 승인해 주세요.',
                'WIKI_INVALID_WML': 'WML 버전 형식과 중복 여부를 확인해 주세요.',
                'WIKI_INVALID_FIELDS': '입력 항목과 게임 호환 범위를 확인해 주세요.',
                'WIKI_GAME_FAMILY_CHANGED': '게임 계열은 수정할 수 없습니다. 다른 게임 계열은 새로 등록해 주세요.',
                'WIKI_AMBIGUOUS_MOD': '같은 ID의 게임 계열이 여러 개입니다. 목록을 새로고침해 계열을 선택해 주세요.',
            }
            if detail in messages:
                raise WikiError(messages[detail]) from None
            if error.code in (401, 403):
                raise WikiError('로그인 정보 또는 관리자 권한을 확인해 주세요.') from None
            if error.code == 409:
                raise WikiError('다른 관리자가 먼저 변경했습니다. 목록을 새로고침해 주세요.') from None
            raise WikiError(f'서버 요청이 실패했습니다. (HTTP {error.code})') from None
        except (urllib.error.URLError, TimeoutError, UnicodeError, json.JSONDecodeError, OSError):
            raise WikiError('서버에 연결하지 못했습니다. 연결 상태와 프로젝트 설정을 확인해 주세요.') from None

    def _set_session(self, response):
        token = response.get('access_token') if isinstance(response, dict) else None
        refresh = response.get('refresh_token') if isinstance(response, dict) else None
        if not isinstance(token, str) or not token or not isinstance(refresh, str) or not refresh:
            raise WikiError('로그인 응답을 확인할 수 없습니다.')
        self.access_token, self.refresh_token = token, refresh

    def login(self, email, password):
        self.logout()
        response = self.request('/auth/v1/token?grant_type=password', {'email': email, 'password': password}, auth=False)
        self._set_session(response)
        try:
            if self.rpc('wiki_is_admin', {}) is not True:
                raise WikiError('이 계정에는 관리자 권한이 없습니다.')
        except Exception:
            self.logout()
            raise

    def logout(self):
        self.access_token = None
        self.refresh_token = None

    def pending(self):
        return self.request('/rest/v1/wiki_submissions?status=eq.pending&select=*&order=created_at.asc')

    def published(self):
        return self.request('/rest/v1/wiki_mods?select=*&order=name.asc')

    def rpc(self, name, payload):
        if name not in ('wiki_is_admin', 'wiki_review', 'wiki_edit_submission', 'wiki_edit_mod', 'wiki_set_trusted_source', 'wiki_mark_manual_review'):
            raise WikiError('지원하지 않는 관리자 작업입니다.')
        return self.request('/rest/v1/rpc/' + name, payload)
