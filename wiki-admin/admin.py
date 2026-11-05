import json
import re
import sys
import threading
import tkinter as tk
import webbrowser
from pathlib import Path
from tkinter import messagebox, simpledialog, ttk

from client import WikiClient, WikiError


CATEGORIES = ('유틸', '콘텐츠', 'H 장면', '그림', '프롬프트', '미분류', '기타')
SEMVER = re.compile(r'^(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})$')
GAME_FAMILY = re.compile(r'^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$')
FIELDS = (
    ('name', '모드 이름'), ('post_url', '코네 게시글 주소'),
    ('wml_versions', '지원 WML 버전 (쉼표로 구분)'), ('game_spec', '게임 호환 조건'),
    ('category', '카테고리'), ('version', '배포 버전'), ('api_version', '업데이트 API 버전'),
)


def editable(row):
    return {
        'name': str(row.get('name') or '').strip(),
        'post_url': str(row.get('post_url') or '').strip(),
        'wml_versions': list(row.get('wml_versions') or []),
        'game_spec': str(row.get('game_spec') or '').strip(),
        'description': str(row.get('description') or '').strip(),
        'category': str(row.get('category') or '').strip(),
        'version': str(row.get('version') or '').strip(),
        'api_version': row.get('api_version') or None,
    }


def validate_edit(values):
    if not values['name'] or not values['post_url'] or not values['category']:
        raise WikiError('이름, 게시글 주소와 카테고리를 입력해 주세요.')
    if not SEMVER.fullmatch(values['version']):
        raise WikiError('배포 버전을 1.2.3 형식으로 입력해 주세요.')
    if any(not SEMVER.fullmatch(item) for item in values['wml_versions']) or len(set(values['wml_versions'])) != len(values['wml_versions']):
        raise WikiError('WML 버전을 0.9.5 형식으로 중복 없이 입력해 주세요.')
    if not values['wml_versions'] and not values['game_spec']:
        raise WikiError('지원 WML 버전 또는 게임 호환 조건을 입력해 주세요.')


def trusted_package(row):
    digest = row.get('package_sha256')
    return digest if row.get('verification') == 'server_verified' and row.get('api_verified') is True and isinstance(digest, str) and re.fullmatch(r'[a-f0-9]{64}', digest) else None


def family_of(row):
    family = row.get('game_family')
    if not isinstance(family, str) or len(family) > 64 or not GAME_FAMILY.fullmatch(family):
        raise WikiError('게임 계열 정보가 올바르지 않습니다. 목록을 새로고침해 주세요.')
    return family


def record_key(kind, row):
    family = family_of(row)
    key = row.get('id') if kind == 'pending' else row.get('mod_id')
    if not isinstance(key, str) or not key or ':' in key:
        raise WikiError('모드 식별 정보가 올바르지 않습니다. 목록을 새로고침해 주세요.')
    return key if kind == 'pending' else family + ':' + key


def family_label(row):
    family = family_of(row)
    return {'wayward': '일반 WML', 'faith': 'Faith', 'overtime': 'Overtime', 'any': '공용'}.get(family, family)


class AdminApp:
    def __init__(self, root, client):
        self.root, self.client = root, client
        self.root.title('모드 위키 관리자')
        self.root.geometry('1180x760')
        self.root.minsize(860, 600)
        self.root.configure(bg='#13191d')
        self.busy = False
        self.rows = {'pending': {}, 'published': {}}
        self.selected = None
        self.saved = None
        self.fields = {}
        self.controls = []
        self._style()
        self._login_screen()

    def _style(self):
        style = ttk.Style(self.root)
        style.theme_use('clam')
        style.configure('.', background='#13191d', foreground='#eeeae1', fieldbackground='#1b282f', font=('맑은 고딕', 10))
        style.configure('TFrame', background='#13191d')
        style.configure('TLabel', background='#13191d', foreground='#eeeae1')
        style.configure('Muted.TLabel', foreground='#b6c2c7')
        style.configure('Title.TLabel', font=('맑은 고딕', 18, 'bold'))
        style.configure('TButton', padding=(12, 8), background='#233139', foreground='#eeeae1')
        style.map('TButton', background=[('active', '#31434c')], foreground=[('disabled', '#87969c')])
        style.configure('Primary.TButton', background='#dec18e', foreground='#1c2529')
        style.map('Primary.TButton', background=[('active', '#ecd5ae'), ('disabled', '#7d7567')])
        style.configure('Treeview', rowheight=31, background='#1b282f', fieldbackground='#1b282f', foreground='#eeeae1')
        style.configure('Treeview.Heading', background='#233139', foreground='#eeeae1', font=('맑은 고딕', 9, 'bold'))
        style.map('Treeview', background=[('selected', '#455760')], foreground=[('selected', '#ffffff')])
        style.configure('TNotebook', borderwidth=0)
        style.configure('TNotebook.Tab', padding=(14, 8), background='#1b282f', foreground='#bcc8cd')
        style.map('TNotebook.Tab', background=[('selected', '#31434c')], foreground=[('selected', '#ffffff')])

    def _clear(self):
        for child in self.root.winfo_children():
            child.destroy()

    def _login_screen(self):
        self._clear()
        frame = ttk.Frame(self.root, padding=36)
        frame.place(relx=.5, rely=.42, anchor='center', width=440)
        ttk.Label(frame, text='모드 위키 관리자', style='Title.TLabel').pack(anchor='w')
        ttk.Label(frame, text='관리자로 등록된 Supabase 계정으로 로그인하세요.', style='Muted.TLabel', wraplength=360).pack(anchor='w', pady=(6, 20))
        ttk.Label(frame, text='이메일').pack(anchor='w')
        self.email = ttk.Entry(frame)
        self.email.pack(fill='x', pady=(4, 14), ipady=5)
        ttk.Label(frame, text='비밀번호').pack(anchor='w')
        self.password = ttk.Entry(frame, show='•')
        self.password.pack(fill='x', pady=(4, 18), ipady=5)
        self.login_button = ttk.Button(frame, text='로그인', style='Primary.TButton', command=self.login)
        self.login_button.pack(fill='x')
        self.login_status = ttk.Label(frame, text='', style='Muted.TLabel', wraplength=360)
        self.login_status.pack(anchor='w', pady=(12, 0))
        self.password.bind('<Return>', lambda event: self.login())
        self.email.focus_set()

    def login(self):
        if self.busy:
            return
        email, password = self.email.get().strip(), self.password.get()
        if not email or not password:
            self.login_status.configure(text='이메일과 비밀번호를 입력해 주세요.')
            return
        self.password.delete(0, tk.END)
        self.login_button.state(['disabled'])
        self.login_status.configure(text='로그인과 관리자 권한을 확인하고 있습니다…')
        self.busy = True

        def work():
            try:
                self.client.login(email, password)
            except Exception as error:
                message = str(error) if isinstance(error, WikiError) else '로그인 중 오류가 발생했습니다.'
                self.root.after(0, lambda: finish(message))
            else:
                self.root.after(0, lambda: finish(None))

        def finish(error):
            self.busy = False
            if error:
                self.login_button.state(['!disabled'])
                self.login_status.configure(text=error)
                self.password.focus_set()
            else:
                self.login_email = email
                self._main_screen()
                self.refresh()

        threading.Thread(target=work, daemon=True).start()

    def _main_screen(self):
        self._clear()
        self.rows = {'pending': {}, 'published': {}}
        self.selected = self.saved = None
        self.controls = []
        outer = ttk.Frame(self.root, padding=24)
        outer.pack(fill='both', expand=True)
        top = ttk.Frame(outer)
        top.pack(fill='x', pady=(0, 16))
        ttk.Label(top, text='모드 위키 관리', style='Title.TLabel').pack(side='left')
        ttk.Button(top, text='로그아웃', command=self.logout).pack(side='right')
        reauth = ttk.Button(top, text='다시 로그인', command=self.reauthenticate)
        reauth.pack(side='right', padx=(0, 8))
        self.controls.append(reauth)
        refresh = ttk.Button(top, text='새로고침', command=self.refresh)
        refresh.pack(side='right', padx=(0, 8))
        self.controls.append(refresh)
        self.status = ttk.Label(outer, text='목록을 불러오세요.', style='Muted.TLabel')
        self.status.pack(anchor='w', pady=(0, 12))
        pane = ttk.Panedwindow(outer, orient='horizontal')
        pane.pack(fill='both', expand=True)
        left, right = ttk.Frame(pane), ttk.Frame(pane, padding=(24, 0, 0, 0))
        pane.add(left, weight=1)
        pane.add(right, weight=2)
        self.notebook = ttk.Notebook(left)
        self.notebook.pack(fill='both', expand=True)
        self.trees = {}
        for kind, title in [('pending', '승인 대기'), ('published', '공개된 모드')]:
            container = ttk.Frame(self.notebook)
            self.notebook.add(container, text=title)
            tree = ttk.Treeview(container, columns=('name', 'family', 'version'), show='headings', selectmode='browse')
            tree.heading('name', text='모드'); tree.heading('family', text='게임 계열'); tree.heading('version', text='버전')
            tree.column('name', width=190, minwidth=120); tree.column('family', width=95, minwidth=70, stretch=False); tree.column('version', width=85, minwidth=70, stretch=False)
            scrollbar = ttk.Scrollbar(container, orient='vertical', command=tree.yview)
            tree.configure(yscrollcommand=scrollbar.set)
            tree.pack(side='left', fill='both', expand=True); scrollbar.pack(side='right', fill='y')
            tree.bind('<<TreeviewSelect>>', lambda event, group=kind: self.select(group))
            self.trees[kind] = tree
        self.record_title = ttk.Label(right, text='항목을 선택해 주세요.', font=('맑은 고딕', 13, 'bold'))
        self.record_title.pack(anchor='w')
        self.record_info = ttk.Label(right, text='승인 대기 신청 또는 공개된 모드를 선택해 수정합니다.', style='Muted.TLabel', wraplength=600)
        self.record_info.pack(anchor='w', pady=(4, 8))
        form = ttk.Frame(right)
        form.pack(fill='both', expand=True)
        form.columnconfigure(1, weight=1)
        for index, (key, label) in enumerate(FIELDS):
            ttk.Label(form, text=label).grid(row=index, column=0, sticky='nw', padx=(0, 14), pady=5)
            entry = ttk.Combobox(form, values=CATEGORIES) if key == 'category' else ttk.Entry(form)
            entry.grid(row=index, column=1, sticky='ew', pady=4, ipady=4)
            self.fields[key] = entry
        description_row = len(FIELDS)
        ttk.Label(form, text='모드 설명').grid(row=description_row, column=0, sticky='nw', padx=(0, 14), pady=5)
        self.description = tk.Text(form, height=5, wrap='word', bg='#1b282f', fg='#eeeae1', insertbackground='#dec18e', relief='flat', highlightthickness=1, highlightbackground='#607178', highlightcolor='#dec18e', font=('맑은 고딕', 10))
        self.description.grid(row=description_row, column=1, sticky='nsew', pady=4)
        form.rowconfigure(description_row, weight=1)
        ttk.Label(form, text='심사 메모\n(소유권 확인 시 필수)').grid(row=description_row+1, column=0, sticky='nw', padx=(0, 14), pady=5)
        self.note = ttk.Entry(form)
        self.note.grid(row=description_row+1, column=1, sticky='ew', pady=4, ipady=4)
        actions = ttk.Frame(right)
        actions.pack(fill='x', pady=(14, 0))
        self.save_button = ttk.Button(actions, text='변경사항 저장', command=self.save)
        self.save_button.pack(side='left')
        self.approve_button = ttk.Button(actions, text='신청 승인', style='Primary.TButton', command=lambda: self.review('approved'))
        self.approve_button.pack(side='right')
        self.reject_button = ttk.Button(actions, text='신청 반려', command=lambda: self.review('rejected'))
        self.reject_button.pack(side='right', padx=8)
        more = ttk.Frame(right)
        more.pack(fill='x', pady=(10, 0))
        self.post_button = ttk.Button(more, text='게시글 열기', command=self.open_post)
        self.post_button.pack(side='left')
        self.verify_button = ttk.Button(more, text='직접 검증 완료', command=self.mark_reviewed)
        self.verify_button.pack(side='left', padx=(8, 0))
        self.trust_button = ttk.Button(more, text='소유권 확인 · 자동 등록 허용', command=self.trust_source)
        self.trust_button.pack(side='left', padx=8)
        self.controls.extend([self.save_button, self.approve_button, self.reject_button, self.post_button, self.trust_button, self.verify_button])
        self.update_actions()

    def run(self, label, task, done):
        if self.busy:
            return
        self.busy = True
        self.status.configure(text=label)
        self.update_actions()
        for tree in self.trees.values():
            tree.configure(selectmode='none')
        for field in self.fields.values():
            field.state(['disabled'])
        self.description.configure(state='disabled')
        self.note.state(['disabled'])

        def work():
            try:
                value = task()
            except Exception as error:
                message = str(error) if isinstance(error, WikiError) else '처리 중 오류가 발생했습니다.'
                self.root.after(0, lambda: finish(None, message))
            else:
                self.root.after(0, lambda: finish(value, None))

        def finish(value, error):
            self.busy = False
            for tree in self.trees.values():
                tree.configure(selectmode='browse')
            for field in self.fields.values():
                field.state(['!disabled'])
            self.description.configure(state='normal')
            self.note.state(['!disabled'])
            self.update_actions()
            if error:
                self.status.configure(text=error)
            else:
                done(value)
        threading.Thread(target=work, daemon=True).start()

    def update_actions(self):
        for control in self.controls:
            control.state(['disabled'] if self.busy else ['!disabled'])
        if not self.selected or self.busy:
            self.save_button.state(['disabled']); self.post_button.state(['disabled']); self.trust_button.state(['disabled'])
        if not self.selected or self.selected[0] != 'pending' or self.busy:
            self.approve_button.state(['disabled']); self.reject_button.state(['disabled']); self.verify_button.state(['disabled'])
        if not self.selected or self.selected[0] != 'pending' or not trusted_package(self.rows['pending'].get(self.selected[1], {})) or self.busy:
            self.trust_button.state(['disabled'])

    def payload(self):
        values = {key: entry.get().strip() for key, entry in self.fields.items()}
        values['wml_versions'] = [v.strip() for v in values['wml_versions'].split(',') if v.strip()]
        values['api_version'] = values['api_version'] or None
        values['description'] = self.description.get('1.0', 'end-1c').strip()
        return values

    def is_dirty(self):
        return self.selected is not None and self.saved != self.payload()

    def discard_ok(self):
        return not self.is_dirty() or messagebox.askyesno('변경사항 확인', '저장하지 않은 변경사항이 있습니다. 계속할까요?', parent=self.root)

    def select(self, kind):
        selection = self.trees[kind].selection()
        if not selection or self.busy:
            return
        key = selection[0]
        row = self.rows[kind].get(key)
        if not row or self.selected == (kind, key):
            return
        if not self.discard_ok():
            self.trees[kind].selection_remove(key)
            if self.selected and self.selected[0] == kind:
                self.trees[kind].selection_set(self.selected[1])
            return
        self.selected = (kind, key)
        self.saved = editable(row)
        self.record_title.configure(text=f"{row.get('name') or row['mod_id']} · {row['mod_id']} · {family_label(row)}")
        kind_label = {'create': '신규 등록', 'revision': '수정 신청'}.get(row.get('kind'), '미확인')
        verified_label = {'unverified': '미검증', 'server_verified': '서버 검증 완료', 'manual_review': '관리자 확인 필요'}.get(row.get('verification'), '미확인')
        info = f"신청 유형: {kind_label} · 검증: {verified_label} · 리비전: {row.get('revision', '—')}" if kind == 'pending' else f"공개된 모드 · 리비전: {row.get('revision', '—')}"
        self.record_info.configure(text=info + '\n게임 조건 예: 일반은 날짜 또는 빈값, Faith는 faith>=3.3.2, Overtime은 overtime>=1.0.0, 공용은 *. 계열 변경은 새로 등록하세요.')
        for name, entry in self.fields.items():
            entry.delete(0, tk.END)
            value = self.saved[name]
            entry.insert(0, ', '.join(value) if isinstance(value, list) else value or '')
        self.description.delete('1.0', tk.END)
        self.description.insert('1.0', self.saved['description'])
        self.note.delete(0, tk.END)
        self.status.configure(text='변경 후 저장하세요.' if kind == 'published' else '내용을 검토하고 승인 또는 반려하세요.')
        self.update_actions()

    def refresh(self, *, discard=True, expected_revision=None):
        if discard and not self.discard_ok():
            return
        previous = self.selected
        previous_note = self.note.get() if previous else ''
        if previous and expected_revision is None:
            expected_revision = self.rows.get(previous[0], {}).get(previous[1], {}).get('revision')
        def load():
            return self.client.pending(), self.client.published()
        def done(values):
            pending, published = values
            if not isinstance(pending, list) or not isinstance(published, list):
                self.status.configure(text='목록 응답 형식이 올바르지 않습니다.')
                return
            try:
                indexed = {kind: [(record_key(kind, row), row) for row in records] for kind, records in [('pending', pending), ('published', published)]}
                if any(len({key for key, _ in values}) != len(values) for values in indexed.values()):
                    raise WikiError('중복된 모드 식별 정보가 있습니다. 목록을 새로고침해 주세요.')
            except (WikiError, AttributeError) as error:
                self.status.configure(text=str(error) if isinstance(error, WikiError) else '목록 응답 형식이 올바르지 않습니다.')
                return
            self.selected = self.saved = None
            for kind, records in indexed.items():
                tree = self.trees[kind]
                tree.delete(*tree.get_children())
                self.rows[kind] = {}
                for key, row in records:
                    self.rows[kind][key] = row
                    tree.insert('', 'end', iid=key, values=(row.get('name') or row.get('mod_id'), family_label(row), row.get('version') or '—'))
            self.record_title.configure(text='항목을 선택해 주세요.')
            self.record_info.configure(text='승인 대기 신청 또는 공개된 모드를 선택해 수정합니다.')
            for field in self.fields.values(): field.delete(0, tk.END)
            self.description.delete('1.0', tk.END); self.note.delete(0, tk.END)
            self.status.configure(text=f'승인 대기 {len(pending)}건 · 공개 모드 {len(published)}개')
            if previous and previous[1] in self.rows[previous[0]]:
                kind, key = previous
                self.trees[kind].selection_set(key)
                self.select(kind)
                if self.rows[kind][key].get('revision') == expected_revision:
                    self.note.insert(0, previous_note)
                elif previous_note:
                    self.status.configure(text='다른 변경이 감지되어 심사 메모를 초기화했습니다. 내용을 다시 확인해 주세요.')
            self.update_actions()
        self.run('목록을 불러오고 있습니다…', load, done)

    def save(self):
        if not self.selected or self.busy:
            return
        kind, key = self.selected
        row = self.rows[kind][key]
        values = self.payload()
        try:
            validate_edit(values)
        except WikiError as error:
            self.status.configure(text=str(error))
            return
        params = {'p_expected_revision': row['revision'], 'p_payload': values}
        if kind == 'pending':
            params['p_submission_id'] = key
        else:
            params.update(p_mod_id=row['mod_id'], p_game_family=family_of(row))
        operation = 'wiki_edit_submission' if kind == 'pending' else 'wiki_edit_mod'
        self.run('변경사항을 저장하고 있습니다…', lambda: self.client.rpc(operation, params),
                 lambda _: self.refresh(discard=False, expected_revision=row['revision'] + 1))

    def review(self, decision):
        if not self.selected or self.selected[0] != 'pending' or self.busy:
            return
        if self.is_dirty():
            self.status.configure(text='수정한 내용을 저장한 뒤 승인 또는 반려해 주세요.')
            return
        key = self.selected[1]
        row = self.rows['pending'][key]
        verb = '승인' if decision == 'approved' else '반려'
        note = self.note.get().strip()
        if decision == 'approved' and row.get('verification') == 'unverified':
            self.status.configure(text='아직 검증되지 않은 신청입니다. 게시글과 ZIP을 확인한 뒤 직접 검증 완료를 눌러 주세요.')
            return
        if decision == 'approved' and row.get('verification') != 'server_verified':
            if not note:
                self.status.configure(text='서버에서 검증하지 못한 신청입니다. 직접 확인한 근거를 심사 메모에 입력해 주세요.')
                return
            question = (f"{row.get('name') or row['mod_id']} ({family_label(row)}) 신청은 서버가 게시글과 ZIP을 직접 검증하지 못했습니다.\n\n"
                        '게시글과 실제 ZIP의 모드 ID, 버전, 호환성을 직접 확인했나요? '
                        '확인한 경우에만 승인하세요.')
        else:
            question = f"{row.get('name') or row['mod_id']} ({family_label(row)}) 신청을 {verb}할까요?"
        if not messagebox.askyesno('신청 ' + verb, question, parent=self.root):
            return
        params = {'p_submission_id': key, 'p_expected_revision': row['revision'], 'p_decision': decision, 'p_note': note or None}
        self.run(f'신청을 {verb}하고 있습니다…', lambda: self.client.rpc('wiki_review', params), lambda _: self.refresh(discard=False))

    def mark_reviewed(self):
        if not self.selected or self.selected[0] != 'pending' or self.busy:
            return
        if self.is_dirty():
            self.status.configure(text='수정한 내용을 저장한 뒤 직접 검증해 주세요.')
            return
        note = self.note.get().strip()
        if not note:
            self.status.configure(text='게시글과 ZIP을 확인한 근거를 심사 메모에 입력해 주세요.')
            return
        row = self.rows['pending'][self.selected[1]]
        prompt = (f"{row.get('name') or row['mod_id']} ({family_label(row)})의 게시글과 실제 ZIP을 확인했나요?\n\n"
                  '모드 ID와 버전, 호환 조건 및 다운로드 파일을 직접 확인한 경우에만 기록하세요.')
        if not messagebox.askyesno('직접 검증 확인', prompt, parent=self.root):
            return
        params = {'p_submission_id': self.selected[1], 'p_expected_revision': row['revision'], 'p_note': note}
        self.run('검증 결과를 기록하고 있습니다…', lambda: self.client.rpc('wiki_mark_manual_review', params),
                 lambda _: self.refresh(discard=False, expected_revision=row['revision'] + 1))

    def open_post(self):
        if not self.selected or self.busy:
            return
        row = self.rows[self.selected[0]][self.selected[1]]
        url = row.get('post_url') or ''
        if not re.fullmatch(r'https://kone\.gg/s/[A-Za-z0-9_-]+/[A-Za-z0-9_-]{22}', url):
            self.status.configure(text='게시글 주소를 확인해 주세요.')
            return
        webbrowser.open(url)

    def trust_source(self):
        if not self.selected or self.busy:
            return
        if self.is_dirty():
            self.status.configure(text='수정한 내용을 저장한 뒤 소유권을 확인해 주세요.')
            return
        row = self.rows[self.selected[0]][self.selected[1]]
        digest = trusted_package(row) if self.selected[0] == 'pending' else None
        if not digest:
            self.status.configure(text='자동 등록 허용은 서버가 ZIP과 API 후보를 검증한 신청에서만 가능합니다.')
            return
        note = self.note.get().strip()
        if not note:
            self.status.configure(text='소유권을 확인한 근거를 심사 메모에 입력해 주세요.')
            return
        message = (f"게임 계열: {family_label(row)}\n모드 ID: {row['mod_id']}\n게시글: {row['post_url']}\n버전: {row['version']}\nZIP SHA-256: {digest}\n\n"
                   '모드 작성자의 소유권과 이 정확한 ZIP에서 업데이트 API가 실제로 동작하는지 직접 확인했나요? '
                   '확인하면 서버 검증을 통과한 이 출처와 파일만 자동 등록할 수 있습니다.')
        if not messagebox.askyesno('소유권 확인', message, parent=self.root):
            return
        params = {'p_mod_id': row['mod_id'], 'p_game_family': family_of(row), 'p_post_url': row['post_url'], 'p_version': row['version'], 'p_package_sha256': digest, 'p_note': note}
        self.run('소유권 확인을 기록하고 있습니다…', lambda: self.client.rpc('wiki_set_trusted_source', params),
                 lambda _: self.refresh(discard=False))

    def reauthenticate(self):
        if self.busy:
            return
        password = simpledialog.askstring('다시 로그인', '관리자 비밀번호를 입력해 주세요. 작성 중인 내용은 유지됩니다.', show='•', parent=self.root)
        if not password:
            return
        self.run('관리자 로그인을 확인하고 있습니다…', lambda: self.client.login(self.login_email, password),
                 lambda _: self.status.configure(text='다시 로그인했습니다. 작성 중인 내용을 저장할 수 있습니다.'))

    def logout(self):
        if self.busy or not self.discard_ok():
            return
        self.client.logout()
        self._login_screen()


def main():
    config_path = Path(__file__).with_name('config.json')
    config = json.loads(config_path.read_text(encoding='utf-8'))
    root = tk.Tk()
    AdminApp(root, WikiClient(config['public_key']))
    root.mainloop()


if __name__ == '__main__':
    main()
