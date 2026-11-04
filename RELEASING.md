# 도우미 배포와 자체 업데이트

사용자는 처음에 User ZIP의 Install.cmd를 실행하고 Chrome/Edge에서 압축 해제된 확장 폴더와 파일 URL 접근을 등록합니다. 이후 Windows 도우미가 GitHub Releases에서 서명된 새 버전을 브라우저 시작 시와 주기적으로 확인하며 연결된 게임을 시작할 때도 한 번 확인합니다. 도우미 화면에서 **도우미 업데이트 확인**을 눌러 즉시 확인할 수도 있습니다. 현재 버전과 상태가 표시되며 새 버전이 있으면 작업을 마친 뒤 업데이트 후 재시작 버튼으로 적용합니다. 다른 도우미 창이 열려 있으면 그 창을 닫고 다시 시도합니다. 자동 확인은 설치하지 않으며 게임 탭을 새로고침하지 않고 확장만 다시 시작합니다.

GitHub Releases에는 다음 3개 파일을 같은 정식 릴리스에 올립니다. Draft·Prerelease는 자동 업데이트 배포로 사용하지 않습니다.

- Mod-Update-Helper-User-X.Y.Z.zip
- Mod-Update-Helper-Modder-X.Y.Z.zip
- wml-updater-release.json

## 최초 발행자 설정

```text
node release.mjs init aip97/mod-update-helper
```

공개 저장소와 검증용 공개키는 self-update-config.json에 저장됩니다. 비공개 서명키는 **.release-signing/private-key.pem**에만 저장됩니다. 키는 ZIP·공개 저장소에 포함하지 말고 별도 안전한 위치에 백업하세요. 이 키를 잃으면 기존 설치의 자동 업데이트 신뢰를 유지할 수 없어서 수동 재설치가 필요합니다.

## 새 버전 발행

1. manifest.json, package.json, wml-reader.js·game-bridge.js의 재연결 버전, 문서의 버전을 같은 X.Y.Z로 올리고 변경 내용을 검증합니다.
2. Node.js 22 이상·Python 3 환경에서 npm test를, Windows PowerShell 5.1 환경에서 npm run test:windows를 실행합니다. 실제 브라우저와 라이브 게임 검증 여부는 별도로 기록합니다.
3. node package.mjs를 실행하여 User/Modder ZIP을 만듭니다. 같은 파일이 이미 있으면 덮어쓰지 않으므로 새 버전 또는 별도 출력 폴더를 사용합니다.
4. node release.mjs sign을 실행합니다. User ZIP의 SHA-256과 내부 모든 파일 해시·버전·고정 확장 ID를 서명합니다. 이후 ZIP을 바꾸면 다시 서명해야 합니다.
5. node export-source.mjs로 공개할 도우미 소스만 release-source/에 복사합니다. 게임 저장소 전체나 기존 게임 Git 이력을 올리지 않습니다. 서명키·다운로드·테스트 브라우저 데이터는 내보내지 않습니다.
6. 검토한 소스를 GitHub에 올리고 태그 vX.Y.Z의 정식 릴리스에 위 3개 파일을 첨부합니다. 이후 설치본은 시작 시 및 6시간마다 확인합니다.

저장소·검증키가 바뀌는 배포는 기존 설치에서 거부합니다. 같은 키를 유지하세요. 훼손된 ZIP·서명 불일치·낮은 버전·예상 밖 경로는 설치하지 않습니다. 새 확장이 120초 안에 시작 확인을 보내지 않으면 Windows 복구 도우미가 이전 파일을 복원합니다. 최신 버전의 재시도가 반복 실패하면 같은 버전을 다시 설치하지 않습니다.

0.7.3 이상의 도우미는 이후 자체 업데이트 ZIP의 서명과 해시를 확인한 뒤 Microsoft Defender로 검사하고, 위협이 발견되거나 검사를 완료할 수 없으면 적용하지 않습니다. 0.7.2 이하에서 0.7.3으로 업데이트할 때와 최초 설치에는 이 자동 검사가 적용되지 않습니다. Defender 검사가 모든 악성 파일이나 안전성을 보장하지는 않습니다.

도우미 설치 경로는 %LOCALAPPDATA%/ModUpdateHelper/extension입니다. 기본 비밀번호는 사용자의 해당 브라우저 로컬 확장 저장소에만 보관합니다. 발행자의 GitHub 자격 증명은 배포 ZIP에 들어가지 않습니다. 사용자에게 GitHub 로그인이나 다운로드 뒤 EXE 실행을 요구하지 않습니다.

현재 자체 업데이트는 Windows Chrome/Edge의 로컬 도우미 방식입니다. Chrome 웹스토어 배포나 운영체제 시작 시 자동 실행 서비스는 구성하지 않습니다. 게임 본체 업데이트 API는 GAME_UPDATE.md의 별도 계약을 따릅니다.
