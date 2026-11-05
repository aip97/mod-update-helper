# 도우미 배포와 자체 업데이트

사용자는 처음에 User ZIP의 Install.cmd를 실행하고 Chrome/Edge에서 압축 해제된 확장 폴더와 파일 URL 접근을 등록합니다. 이후 도우미가 코네 배포 게시글(self-update-config.json의 `postURL`, 현재 https://kone.gg/s/wayward-wml/cxDZPwAi6ZQYfWwmovNAeb)에서 서명된 새 버전을 브라우저 시작 시와 주기적으로 확인하며 연결된 게임을 시작할 때도 한 번 확인합니다. 도우미 화면에서 **도우미 업데이트 확인**을 눌러 즉시 확인할 수도 있습니다. 현재 버전과 상태가 표시되며 새 버전이 있으면 작업을 마친 뒤 업데이트 후 재시작 버튼으로 적용합니다. 다른 도우미 창이 열려 있으면 그 창을 닫고 다시 시도합니다. 자동 확인은 설치하지 않으며 게임 탭을 새로고침하지 않고 확장만 다시 시작합니다.

배포 게시글 본문에는 Kio 공유 링크를 그대로 또는 Base64로 넣습니다(모드 게시글과 같은 형식). 그 Kio 컬렉션에 다음 파일을 함께 올립니다.

- Mod-Update-Helper-User-X.Y.Z.zip
- wml-updater-release.json (또는 wml-updater-release-X.Y.Z.json) — 같은 버전의 서명 파일
- Mod-Update-Helper-Modder-X.Y.Z.zip (선택, 자동 업데이트에는 쓰지 않음)

도우미는 가장 높은 버전의 User ZIP과 버전이 일치하는 서명 파일을 찾습니다. 같은 최신 버전 ZIP이 둘 이상이거나 서명 파일이 없으면 설치하지 않습니다. 컬렉션 비밀번호는 사용자가 저장한 모드 업데이트용 Kio 기본 비밀번호를 그대로 사용하므로, 모드 배포와 같은 비밀번호로 잠가 주세요. 게시글은 코네 로그인 후에만 보이므로 로그인하지 않은 사용자에게는 도우미 화면에 ‘코네 로그인 필요’ 경고와 게시글 링크가 표시됩니다.

서명 검증·SHA-256·Defender 검사·파일 교체는 여전히 Windows 네이티브 도우미가 수행합니다. 확장은 게시글과 Kio에서 받은 서명 파일과 ZIP을 그대로 전달할 뿐이므로, 게시글이나 Kio 컬렉션이 바뀌어도 발행자 서명이 없는 파일은 설치되지 않습니다. self-update-config.json의 `repository` 값은 이제 다운로드 주소가 아니라 서명에 포함되는 발행자 식별자입니다. 바꾸지 마세요.

## 최초 발행자 설정

```text
node release.mjs init aip97/mod-update-helper
```

공개 저장소와 검증용 공개키는 self-update-config.json에 저장됩니다. 비공개 서명키는 **.release-signing/private-key.pem**에만 저장됩니다. 키는 ZIP·공개 저장소에 포함하지 말고 별도 안전한 위치에 백업하세요. 이 키를 잃으면 기존 설치의 자동 업데이트 신뢰를 유지할 수 없어서 수동 재설치가 필요합니다.

## 새 버전 발행

0.8.0 위키 기능은 Supabase 데이터베이스 마이그레이션과 `wiki-registration-v1` Edge 함수 배포, 관리자 로그인 설정, 실제 신청·승인·설치 연동 검증이 선행되어야 합니다. 완료 및 검증 전의 ZIP은 사전 검증용이며 운영 가능한 위키 배포판으로 발행하지 않습니다. 서버의 코네 인증 연동이 완성되기 전에는 게시글·ZIP 자동 수집과 자동 공개를 비활성화하고 모든 신청을 관리자 수동 심사합니다.

1. manifest.json, package.json, wml-reader.js·game-bridge.js의 재연결 버전, 문서의 버전을 같은 X.Y.Z로 올리고 변경 내용을 검증합니다.
2. Node.js 22 이상·Python 3 환경에서 npm test를, Windows PowerShell 5.1 환경에서 npm run test:windows를 실행합니다. 실제 브라우저와 라이브 게임 검증 여부는 별도로 기록합니다.
3. node package.mjs를 실행하여 User/Modder ZIP을 만듭니다. 같은 파일이 이미 있으면 덮어쓰지 않으므로 새 버전 또는 별도 출력 폴더를 사용합니다.
4. node release.mjs sign을 실행합니다. User ZIP의 SHA-256과 내부 모든 파일 해시·버전·고정 확장 ID를 서명합니다. 이후 ZIP을 바꾸면 다시 서명해야 합니다.
5. node export-source.mjs로 공개할 도우미 소스만 release-source/에 복사합니다. 기존 파일을 보존하며 별도 후보를 만들 때는 `node export-source.mjs --output release-artifacts/source-candidate-X.Y.Z`처럼 프로젝트 안의 비어 있는 디렉터리를 지정합니다. 예상 밖 파일이나 링크가 있으면 중단합니다. 게임 저장소 전체나 기존 게임 Git 이력을 올리지 않으며, 서명키·다운로드·테스트 브라우저 데이터는 내보내지 않습니다.
6. User ZIP과 wml-updater-release.json을 배포 Kio 컬렉션에 올리고, 이전 버전의 같은 이름 서명 파일은 교체합니다. 코네 배포 게시글의 Kio 링크(Base64 가능)를 확인합니다. 이후 설치본은 시작 시 및 6시간마다 확인합니다. GitHub 기반 0.8.0 이하 설치본은 이 방식으로 바뀐 첫 버전을 GitHub Releases에서 한 번 더 받아야 하므로, 전환 버전만은 GitHub 릴리스에도 함께 올립니다.

브라우저 테스트는 설치된 Chrome 또는 Chromium과 테스트 전용 Puppeteer가 필요합니다. 아래 명령은 도우미 프로젝트 루트에서 실행하며 운영 패키지나 런타임 의존성을 변경하지 않습니다. 브라우저가 기본 설치 경로에 없으면 `WML_TEST_CHROME`에 실행 파일 절대 경로를 지정하세요. `browser-test.mjs`는 압축 해제 확장 로딩을 지원하는 Chromium 또는 Chrome for Testing이 필요합니다.

```powershell
npm.cmd install --no-save --no-package-lock --ignore-scripts --prefix test-output/browser-deps puppeteer-core@25.12.0
# 필요할 때만: $env:WML_TEST_CHROME = 'C:\path\to\chrome.exe'
node browser-test.mjs
node bulk-browser-test.mjs
node consent-browser-test.mjs
node game-update-browser-test.mjs
node wiki-browser-test.mjs
```

저장소·검증키가 바뀌는 배포는 기존 설치에서 거부합니다. 같은 키를 유지하세요. 훼손된 ZIP·서명 불일치·낮은 버전·예상 밖 경로는 설치하지 않습니다. 새 확장이 120초 안에 시작 확인을 보내지 않으면 Windows 복구 도우미가 이전 파일을 복원합니다. 최신 버전의 재시도가 반복 실패하면 같은 버전을 다시 설치하지 않습니다.

0.7.3 이상의 도우미는 이후 자체 업데이트 ZIP의 서명과 해시를 확인한 뒤 Microsoft Defender로 검사하고, 위협이 발견되거나 검사를 완료할 수 없으면 적용하지 않습니다. 0.7.2 이하에서 0.7.3으로 업데이트할 때와 최초 설치에는 이 자동 검사가 적용되지 않습니다. Defender 검사가 모든 악성 파일이나 안전성을 보장하지는 않습니다.

도우미 설치 경로는 %LOCALAPPDATA%/ModUpdateHelper/extension입니다. 기본 비밀번호는 사용자의 해당 브라우저 로컬 확장 저장소에만 보관합니다. 발행자의 자격 증명은 배포 ZIP에 들어가지 않습니다. 사용자에게는 코네 로그인만 필요하며 다운로드 뒤 EXE 실행을 요구하지 않습니다.

현재 자체 업데이트는 Windows Chrome/Edge의 로컬 도우미 방식입니다. Chrome 웹스토어 배포나 운영체제 시작 시 자동 실행 서비스는 구성하지 않습니다. 게임 본체 업데이트 API는 GAME_UPDATE.md의 별도 계약을 따릅니다.
