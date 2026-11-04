# 모드 위키 서버

`wiki-registration-v1`은 신청을 관리자 검토 대상으로 저장합니다. 현재 서버는 코네 게시글이나 Kio ZIP을 자동 수집하지 않으며, 모든 신청은 관리자가 직접 확인합니다. API 적용 모드도 자동 공개되지 않습니다. Kio 비밀번호와 게임 저장 데이터는 서버로 보내지 않습니다.

서버 설정 `WIKI_KONE_VERIFICATION_ENABLED`의 기본값은 비활성입니다. `true`로 설정해도 코네가 허용한 서버 인증 방식이 아직 확인되지 않아 자동 수집을 시작하지 않고 관리자 검토로 보냅니다. 이전 검증 로직은 `verify-when-approved.mjs`에 보존돼 있지만 운영 함수에 연결돼 있지 않습니다. 추후 서비스의 명시적 허가와 전용 계정에 사용할 공식 인증 방식을 확인하고 서버 전용 인증 수단을 구현·검증한 뒤에만 연결해야 합니다. 계정 비밀번호나 토큰을 확장 프로그램에 넣거나 사용자 계정 정보를 전달하지 않습니다.

관리자는 게시글 접근 권한과 파일, 호환성 및 배포자의 소유권을 직접 확인해야 합니다. 검사 통과는 악성코드가 없다는 보장이 아닙니다.

함수는 Supabase가 제공하는 `SUPABASE_PUBLISHABLE_KEYS`와 `SUPABASE_SECRET_KEYS` 환경 변수를 사용합니다. 공개 키를 `apikey` 헤더에서 직접 확인하므로 배포 시 `verify_jwt`를 `false`로 설정합니다. 공개 키는 사용자 인증 수단이 아니며, 익명 신청의 안전성은 입력 검증과 신청량 제한 및 관리자 검토에 의존합니다. 비밀 키는 클라이언트에 포함하지 않습니다.

신청 횟수 제한은 IP를 서버 비밀 키로 HMAC 처리한 값으로 적용합니다. 비밀 키를 교체하면 기존 IP별 집계와 새 집계가 연결되지 않아 해당 시간대의 IP별 제한이 초기화되지만 전체 신청량 제한은 유지됩니다.

스키마 회귀 테스트는 도우미 프로젝트 루트에서 아래 명령으로 별도 테스트 디렉터리에 고정 버전의 PGlite를 설치한 뒤 실행합니다. 운영 서버와 클라이언트의 런타임 의존성에는 추가되지 않으며 실제 Supabase DB를 변경하지 않습니다.

```powershell
npm.cmd install --no-save --no-package-lock --ignore-scripts --prefix test-output/wiki-pg @electric-sql/pglite@0.5.15
node --test wiki/supabase/schema.test.mjs wiki/supabase/migration.test.mjs
```
