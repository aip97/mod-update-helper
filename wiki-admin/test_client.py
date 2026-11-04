import io
import json
import unittest
import urllib.error
from unittest.mock import patch
from types import SimpleNamespace

from client import NoRedirect, WikiClient, WikiError
from admin import AdminApp, CATEGORIES, editable, family_label, record_key, trusted_package, validate_edit


class Response:
    def __init__(self, value):
        self.data = json.dumps(value).encode()
    def __enter__(self): return self
    def __exit__(self, *_): pass
    def read(self, limit): return self.data[:limit]


class Opener:
    def __init__(self, replies):
        self.replies, self.requests = iter(replies), []
    def open(self, request, timeout):
        self.requests.append((request, timeout))
        result = next(self.replies)
        if isinstance(result, Exception): raise result
        return Response(result)


class AdminClientTests(unittest.TestCase):
    def test_admin_login_review_and_logout(self):
        opener = Opener([{'access_token': 'session-token', 'refresh_token': 'unused'}, True, [], {}])
        client = WikiClient('sb_publishable_test', opener)
        client.login('admin@example.com', 'secret')
        client.pending()
        client.rpc('wiki_review', {'p_submission_id': 'id', 'p_expected_revision': 4, 'p_decision': 'approved', 'p_note': None})
        self.assertEqual(opener.requests[0][0].get_header('Authorization'), None)
        self.assertEqual(opener.requests[1][0].get_header('Authorization'), 'Bearer session-token')
        self.assertEqual(opener.requests[2][0].get_header('Apikey'), 'sb_publishable_test')
        self.assertEqual(json.loads(opener.requests[3][0].data)['p_expected_revision'], 4)
        client.logout()
        self.assertIsNone(client.access_token)
        self.assertIsNone(client.refresh_token)
        with self.assertRaises(WikiError): client.pending()

    def test_non_admin_cannot_remain_logged_in(self):
        client = WikiClient('sb_publishable_test', Opener([{'access_token': 'session', 'refresh_token':'refresh'}, False]))
        with self.assertRaisesRegex(WikiError, '관리자 권한'):
            client.login('user@example.com', 'password')
        self.assertIsNone(client.access_token)
        self.assertIsNone(client.refresh_token)

    def test_expired_session_refreshes_once_and_rotates_token(self):
        unauthorized = urllib.error.HTTPError('https://example.invalid', 401, 'unauthorized', {}, io.BytesIO(b'{}'))
        opener = Opener([{'access_token':'first', 'refresh_token':'refresh-1'}, True, unauthorized,
                         {'access_token':'second', 'refresh_token':'refresh-2'}, []])
        client = WikiClient('sb_publishable_test', opener)
        client.login('admin@example.com', 'password')
        self.assertEqual(client.pending(), [])
        self.assertEqual(opener.requests[3][0].full_url, client.BASE + '/auth/v1/token?grant_type=refresh_token')
        self.assertEqual(json.loads(opener.requests[3][0].data), {'refresh_token':'refresh-1'})
        self.assertIsNone(opener.requests[3][0].get_header('Authorization'))
        self.assertEqual(opener.requests[4][0].get_header('Authorization'), 'Bearer second')
        self.assertEqual(client.refresh_token, 'refresh-2')

    def test_refresh_failure_keeps_draft_and_supports_reauthentication(self):
        unauthorized = urllib.error.HTTPError('https://example.invalid', 401, 'unauthorized', {}, io.BytesIO(b'{}'))
        opener = Opener([{'access_token':'old', 'refresh_token':'refresh'}, True, unauthorized,
                         urllib.error.URLError('offline')])
        client = WikiClient('sb_publishable_test', opener)
        client.login('admin@example.com', 'password')
        with self.assertRaisesRegex(WikiError, '작성 중인 내용은 유지'):
            client.rpc('wiki_edit_mod', {'p_payload':{'description':'unsaved draft'}})
        self.assertEqual(client.refresh_token, 'refresh')
        draft = {'description':'unsaved draft'}
        calls = []
        app = SimpleNamespace(busy=False, root=None, login_email='admin@example.com',
            client=SimpleNamespace(login=lambda email, password: calls.append((email, password))),
            fields=draft, selected=('pending', 'id'), saved={'description':'old'},
            status=SimpleNamespace(configure=lambda **kw: None),
            run=lambda label, task, done: (task(), done(None)))
        with patch('admin.simpledialog.askstring', return_value='new-password'):
            AdminApp.reauthenticate(app)
        self.assertEqual(calls, [('admin@example.com', 'new-password')])
        self.assertEqual(app.fields['description'], 'unsaved draft')
        self.assertEqual(app.selected, ('pending', 'id'))
        self.assertEqual(app.saved['description'], 'old')

    def test_refresh_does_not_loop_on_repeated_unauthorized(self):
        def unauthorized():
            return urllib.error.HTTPError('https://example.invalid', 401, 'unauthorized', {}, io.BytesIO(b'{}'))
        opener = Opener([{'access_token':'old', 'refresh_token':'first'}, True, unauthorized(),
                         {'access_token':'new', 'refresh_token':'second'}, unauthorized()])
        client = WikiClient('sb_publishable_test', opener)
        client.login('admin@example.com', 'password')
        with self.assertRaises(WikiError): client.pending()
        self.assertEqual(len(opener.requests), 5)

    def test_conflict_and_permission_have_safe_messages(self):
        def error(message):
            return urllib.error.HTTPError('https://example.invalid', 400, 'bad', {}, io.BytesIO(json.dumps({'message':message}).encode()))
        client = WikiClient('sb_publishable_test', Opener([error('WIKI_REVISION_CONFLICT'), error('WIKI_ADMIN_REQUIRED')]))
        client.access_token = 'session'
        with self.assertRaisesRegex(WikiError, '먼저 변경'):
            client.rpc('wiki_edit_mod', {})
        with self.assertRaisesRegex(WikiError, '관리자 권한'):
            client.rpc('wiki_set_trusted_source', {})

    def test_secret_keys_and_redirects_are_not_allowed(self):
        for key in ('sb_secret_secret', 'service_role', '', 'eyJhbGciOi...'):
            with self.assertRaises(WikiError): WikiClient(key)
        with self.assertRaises(WikiError):
            NoRedirect().redirect_request(None, None, 302, '', {}, 'https://elsewhere.invalid')

    def test_editable_fields_preserve_null_api_and_versions(self):
        row = {'name':'  Test ', 'post_url':'https://kone.gg/x', 'wml_versions':['0.9.4','0.9.5'],
               'game_spec':'faith>=3.3.2','category':'tools','version':'1.2.3','api_version':None,'description':' text '}
        value = editable(row)
        self.assertEqual(value['wml_versions'], ['0.9.4', '0.9.5'])
        self.assertEqual(value['description'], 'text')
        self.assertIsNone(value['api_version'])

    def test_default_categories_and_custom_category(self):
        self.assertEqual(CATEGORIES, ('유틸', '콘텐츠', 'H 장면', '그림', '프롬프트', '미분류', '기타'))
        values = {'name':'Mod', 'post_url':'https://kone.gg/s/test/abcdefghijklmnopqrstuv',
                  'wml_versions':['0.9.5'], 'game_spec':'', 'category':'사용자 정의', 'version':'1.2.3'}
        validate_edit(values)
        self.assertEqual(values['category'], '사용자 정의')
        with self.assertRaisesRegex(WikiError, 'WML'):
            validate_edit({**values, 'wml_versions':['0.9.5', '0.9.5']})
        with self.assertRaisesRegex(WikiError, '버전'):
            validate_edit({**values, 'version':'01.2.3'})
        with self.assertRaisesRegex(WikiError, '게임 호환'):
            validate_edit({**values, 'wml_versions':[]})
        validate_edit({**values, 'wml_versions':[], 'game_spec':'faith>=3.3.2'})

    def test_unverified_approval_requires_note_and_explicit_confirmation(self):
        calls = []
        app = SimpleNamespace(selected=('pending', 'id'), busy=False, is_dirty=lambda: False,
            rows={'pending': {'id': {'mod_id': 'mod', 'game_family': 'faith', 'name': 'Mod', 'revision': 2, 'verification': 'manual_review'}}},
            note=SimpleNamespace(get=lambda: ''), status=SimpleNamespace(configure=lambda **kw: calls.append(kw['text'])),
            root=None, run=lambda *args: calls.append('submitted'))
        with patch('admin.messagebox.askyesno', return_value=True) as confirm:
            AdminApp.review(app, 'approved')
            self.assertFalse(confirm.called)
            self.assertNotIn('submitted', calls)
            self.assertIn('근거', calls[-1])
            app.note = SimpleNamespace(get=lambda: '게시글 및 ZIP 확인')
            AdminApp.review(app, 'approved')
            self.assertTrue(confirm.called)
            self.assertIn('서버가 게시글과 ZIP을 직접 검증하지 못했습니다', confirm.call_args.args[1])
            self.assertIn('submitted', calls)
            calls.clear()
            app.rows['pending']['id']['verification'] = 'unverified'
            AdminApp.review(app, 'approved')
            self.assertNotIn('submitted', calls)
            self.assertIn('직접 검증 완료', calls[-1])

    def test_trusted_source_is_bound_to_verified_exact_version(self):
        calls = []
        client = SimpleNamespace(rpc=lambda name, payload: calls.append((name, payload)))
        app = SimpleNamespace(selected=('pending', 'id'), busy=False, is_dirty=lambda: False,
            rows={'pending': {'id': {'mod_id': 'mod', 'game_family': 'overtime', 'post_url': 'https://kone.gg/s/a/abcdefghijklmnopqrstuv', 'version': '1.2.3',
                                     'verification':'server_verified', 'api_verified':True, 'package_sha256':'a'*64}}},
            note=SimpleNamespace(get=lambda: '작성자와 이 버전 API 동작 확인'),
            status=SimpleNamespace(configure=lambda **kw: None), root=None, client=client,
            run=lambda label, task, done: task())
        with patch('admin.messagebox.askyesno', return_value=True) as confirm:
            AdminApp.trust_source(app)
            self.assertIn('버전: 1.2.3', confirm.call_args.args[1])
            self.assertIn('ZIP SHA-256: ' + 'a'*64, confirm.call_args.args[1])
        self.assertEqual(calls[0][0], 'wiki_set_trusted_source')
        self.assertEqual(calls[0][1]['p_version'], '1.2.3')
        self.assertEqual(calls[0][1]['p_mod_id'], 'mod')
        self.assertEqual(calls[0][1]['p_game_family'], 'overtime')
        self.assertEqual(calls[0][1]['p_package_sha256'], 'a'*64)

    def test_same_mod_id_keeps_families_separate_on_edit(self):
        faith = {'mod_id':'same-mod','game_family':'faith','revision':2}
        overtime = {'mod_id':'same-mod','game_family':'overtime','revision':5}
        self.assertNotEqual(record_key('published', faith), record_key('published', overtime))
        self.assertEqual(family_label(faith), 'Faith')
        self.assertEqual(record_key('pending', {**faith, 'id':'submission-id'}), 'submission-id')
        with self.assertRaisesRegex(WikiError, '계열'):
            record_key('published', {'mod_id':'same-mod'})
        calls = []
        values = {'name':'Mod','post_url':'https://kone.gg/s/a/abcdefghijklmnopqrstuv',
                  'wml_versions':['0.9.5'],'game_spec':'overtime>=1.0','category':'유틸',
                  'version':'1.2.3','description':'test','api_version':None}
        app = SimpleNamespace(selected=('published', record_key('published', overtime)), busy=False,
            rows={'published':{record_key('published', faith):faith,record_key('published', overtime):overtime}},
            payload=lambda: values, client=SimpleNamespace(rpc=lambda name, payload: calls.append((name,payload))),
            status=SimpleNamespace(configure=lambda **kw: None),
            run=lambda label, task, done: task(), refresh=lambda **kw: None)
        AdminApp.save(app)
        self.assertEqual(calls[0][0], 'wiki_edit_mod')
        self.assertEqual(calls[0][1]['p_mod_id'], 'same-mod')
        self.assertEqual(calls[0][1]['p_game_family'], 'overtime')
        self.assertEqual(calls[0][1]['p_expected_revision'], 5)

    def test_refresh_lists_same_id_for_both_families(self):
        class Tree:
            def __init__(self): self.records = {}
            def get_children(self): return tuple(self.records)
            def delete(self, *keys):
                for key in keys: self.records.pop(key)
            def insert(self, parent, where, *, iid, values):
                if iid in self.records: raise AssertionError('duplicate tree key')
                self.records[iid] = values
        pending, published = Tree(), Tree()
        rows = [{'mod_id':'same-mod','game_family':'faith','name':'Faith Mod','version':'1.0.0'},
                {'mod_id':'same-mod','game_family':'overtime','name':'OT Mod','version':'2.0.0'}]
        label = SimpleNamespace(configure=lambda **kw: None)
        blank = SimpleNamespace(delete=lambda *args: None)
        app = SimpleNamespace(discard_ok=lambda: True, client=SimpleNamespace(pending=lambda:[],published=lambda:rows),
            trees={'pending':pending,'published':published}, rows={}, fields={}, description=blank, note=blank,
            record_title=label, record_info=label, status=label, update_actions=lambda:None,
            run=lambda label,task,done: done(task()))
        AdminApp.refresh(app)
        self.assertEqual(set(app.rows['published']), {'faith:same-mod','overtime:same-mod'})
        self.assertEqual(published.records['faith:same-mod'][1], 'Faith')
        self.assertEqual(published.records['overtime:same-mod'][1], 'Overtime')

    def test_family_change_error_explains_new_registration(self):
        error = urllib.error.HTTPError('https://example.invalid', 400, 'bad', {},
            io.BytesIO(json.dumps({'message':'WIKI_GAME_FAMILY_CHANGED'}).encode()))
        client = WikiClient('sb_publishable_test', Opener([error]))
        client.access_token = 'session'
        with self.assertRaisesRegex(WikiError, '새로 등록'):
            client.rpc('wiki_edit_mod', {})

    def test_unverified_or_invalid_package_cannot_be_trusted(self):
        good = {'verification':'server_verified', 'api_verified':True, 'package_sha256':'f'*64}
        self.assertEqual(trusted_package(good), 'f'*64)
        for row in ({**good, 'verification':'manual_review'}, {**good, 'api_verified':False},
                    {**good, 'package_sha256':None}, {**good, 'package_sha256':'g'*64},
                    {**good, 'package_sha256':'a'*63}, {}):
            self.assertIsNone(trusted_package(row))


if __name__ == '__main__':
    unittest.main()
