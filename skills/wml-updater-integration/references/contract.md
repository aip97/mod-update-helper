# 연동 계약

## 게시글

등록 주소는 발행된 독자용 `https://kone.gg/s/<공간>/<22자 게시글 ID>`다. 공간과 ID는 영문·숫자·`_`·`-`만 사용하며 쿼리, fragment, 자격 증명은 허용하지 않는다. 편집/초안 주소를 넣지 않는다.

형식 예시이며 ID·버전·공유 주소를 실제 자료로 바꾼다:

```text
제목: [my-mod] 1.2.3

본문:
다운로드 (1.2.3)
https://kio.ac/c/abcdefghijklmnopqrstuv
```

제목은 자유 형식이며 여러 모드 ID·버전을 함께 적어도 된다. 본문에 Kio HTTPS 공유 주소 또는 그 주소의 Base64를 넣는다. 최대 8개 컬렉션을 읽으며 같은 링크는 중복 확인하지 않는다. 컬렉션에 여러 모드를 함께 올리고 여러 모드에 같은 게시글 주소를 등록할 수 있다.
파일명은 `<mod-id> X.Y.Z.zip`을 권장한다. `<mod-id>.zip`은 상태 확인 중 내부 헤더에서 버전을 읽는다. 구분자·대소문자가 다른 기존 이름도 ID를 정규화해 후보를 찾되 내부 ID는 정확히 검사한다. 같은 최신 버전 파일이 여러 개면 선택하지 않는다. 제목이나 본문 버전을 파일 버전보다 우선하지 않는다.
Kio 주소는 `https://kio.ac/c/<22자 공유ID>`이며 첫 글자는 a~d다. 쿼리·fragment·자격 증명은 허용하지 않는다. 게시글 링크·파일명 검사 통과가 최종 ZIP 검사나 설치 승인을 대신하지 않는다.

## mod.js 헤더

주석·공백 다음 `WML.define({`로 시작한다. 첫 12,000자 안, `symbols`/`setup` 앞에 `id`, `version`, `game`을 한 번씩 명시적인 문자열로 선언한다. `id`는 `[a-z0-9][a-z0-9._-]*`, 최대 64자이며 끝의 점과 Windows 예약 이름은 불가하다. 모드 이름과 ID, 게임 빌드와 WML 버전을 혼동하지 않는다.

`game`은 256자 이내의 계열 이름, 모든 계열 공용 `*` 또는 같은 계열의 버전 조건이다. 이름은 `[a-z][a-z0-9]*(?:-[a-z0-9]+)*`, 최대 64자다. `wayward`는 날짜 빌드용으로 예약하며 `any`는 내부 공용 표기이므로 직접 선언할 수 없다. 날짜는 실제 달력 날짜 `YYYY-MM-DD`와 선택적 `-pre` 같은 소문자 접미사를 사용한다. `>=2026-11-01`, `>=2026-10-18-pre <2026-11-02`처럼 비교할 수 있다.

이름 있는 계열은 `faith>=3.3.2`, `overtime>=1.0.0`, `harbor>=1.2.0 <harbor-2.0.0`, `>=harbor-1.2.0`, 정확 일치 `harbor-1.2.3`를 지원한다. 비교 연산자는 `>=`, `<=`, `>`, `<`, `=`이며 생략하면 정확 일치다. 공백 조건은 AND다. 버전 숫자는 불필요한 앞자리 0 없이 각 6자리 이내이며 `<계열>-<버전>` 전체가 64자 이내다. 마지막 숫자 접미사를 버전으로 먼저 해석하므로 `harbor-1`은 harbor의 버전 1이다. 계열 이름 자체가 `harbor-1`이라면 `harbor-1>=1.0.0`처럼 비교형으로 명시한다. 다른 계열 혼합, 빈 값, 잘못된 문법은 거부하며 공용으로 추측하지 않는다.

setup(api) {}, async setup(api) {}, setup: async (api) => {} 모두 지원한다.

선택적인 WML 선언:

```js
wml: '0.9.4',
// 또는 실제로 두 버전을 지원한다는 근거가 있을 때
wml: ['0.9.4', '0.9.5'],
```

둘 중 하나만 사용한다. 정확한 `X.Y.Z` 문자열 또는 중복 없는 비어 있지 않은 배열이며 범위, 계산식, 중복 키는 불가하다. 선언이 없으면 호환 미확인이다. 선언이 있다고 실제 게임 실행 검증이 끝난 것은 아니다. 도우미 실행 환경 지원과 개별 모드의 지원 선언도 구분한다.

도우미 0.7.0은 같은 WML 구조의 정확한 X.Y.Z 버전 0.9.3 이상을 인식하며 개별 모드의 WML 선언은 별도로 검사한다. 새 계열을 코드 목록에 추가할 필요는 없다. 실행한 정확한 HTML의 `<meta name="wml-game" content="harbor-1.2.3">`, 기존 `WML_GAME`·부트스트랩·심볼 등 존재하는 식별자가 실행 중 빌드와 일치해야 한다. Faith의 `wf-version`, Overtime의 `ot-version`도 지원하지만 임의의 `*-version` 메타를 추측하지 않는다. 폴더 구조와 `WML.currentPreset()` 등 로더의 공개 규약도 충족해야 한다. 다른 계열·빌드·WML 폴더에는 설치·롤백하지 않는다. **Overtime·새 계열·미래 WML 버전은 가상 파일 검사 범위이며 모든 실제 게임 동작을 검증한 것이 아니다.**

## 선택적 protocol 2 API

일반 모드는 API 없이 업데이트할 수 있다. API는 이름과 게시글 주소를 제공하는 선택적 편의 기능이다. `assets/bridge.js`는 setup 내부에 병합하는 코드이며 독립 mod.js가 아니다.

질의: 같은 window의 `{type: 'WML_MOD_UPDATER_QUERY', requestId}`. requestId는 영문·숫자·`_`·`-` 1~80자다. 다른 키나 외부 source를 거부한다.

응답: `WML_MOD_UPDATER_STATUS`, 같은 `requestId`, `protocol: 2`, `modId`, `modVersion`, `modName`, `active`, `wmlVersion`, `gameVersion`, 선택적 `postURL`. 실제 `WML.currentPreset().mods`에서 활성 상태를 읽으며 실패하면 false다. `wmlVersion`은 `api.wml`, `gameVersion`은 `api.game`의 날짜 빌드 또는 `harbor-1.2.3` 같은 `<계열>-<버전>`이다. 모드의 `game` 요구 조건이 아니다. 공개 메타데이터만 보낸다. 저장 데이터·비밀번호·토큰을 응답에 넣지 않는다.

모드별 `Symbol.for('wml-mod-updater.' + api.id)`로 이전 listener를 제거한 후 등록하여 재실행해도 응답이 중복되지 않게 한다. 유효한 API postURL이 수동 URL보다 우선하며 수동 URL은 유효한 API 주소가 없을 때의 대체다.

## 배포 ZIP

파일명은 `<mod-id> <X.Y.Z>.zip`(사이 공백 하나)이다. 도우미 0.5.1부터 내부 진입점은 다음 여섯 가지를 지원한다. `<mod-id>`는 선택한 실제 모드 ID다.

```text
mod.js
<mod-id>/mod.js
mods/mod.js
mods/<mod-id>/mod.js
wml/mods/mod.js
wml/mods/<mod-id>/mod.js
```

하나의 모드 루트를 자동으로 선택한 모드 폴더에 맞춘다. 바깥 포장 폴더와 역슬래시 경로도 지원한다. 함께 들어 있는 image-packs/는 게임 루트에 적용하며 pack.js·JSON·PNG/JPEG/WebP/GIF/AVIF만 허용한다. 백업·실패 복원·롤백에 포함한다. 전체 게임·다른 모드·서버·실행 파일·상위 경로 이동·대소문자 및 구분자 정규화 중복은 거부한다. ZIP 내부 ID·버전은 선택한 모드와 승인 버전에 반드시 일치해야 한다.

Python 3 표준 라이브러리만 사용하는 동봉 도구는 기존처럼 `wml/mods/<mod-id>/mod.js` 전체 경로 구조로 출력한다. 다른 지원 구조를 반드시 전체 경로로 재포장할 필요는 없다.

```text
python <스킬폴더>/scripts/package-mod.py <배포용-모드폴더> <출력폴더> --id my-mod --version 1.2.3
```

출력 폴더는 존재해야 하며 입력 폴더 밖이어야 한다. 스크립트는 링크/reparse point, 위험 경로, 사용자 데이터 이름, 미지원 확장자, 대소문자 중복, 과대 파일을 거부하며 조용히 누락하거나 기존 ZIP을 덮어쓰지 않는다. 배포용 staging 폴더를 따로 만들어 사용한다.

허용 확장자는 `js mjs json css html md txt png jpg jpeg webp gif svg ico woff woff2 ttf otf mp3 ogg wav`. 디렉터리 포함 최대 4,096항목, 파일당 16 MiB, 압축 해제 총량 512 MiB, ZIP 256 MiB다. 동봉 도구는 압축률 제한을 피하는 stored ZIP을 만든다. 설정·저장·캐시·사용자 이미지·백업·런타임 폴더와 서버/실행 파일을 넣지 않는다. 도구 검사는 사전 검사이며 확장 설치기의 최종 경로·헤더·호환 검사와 설치 승인을 대체하지 않는다.

## 게임 본체 업데이트 (0.7.0)
모드 API는 그대로 유지합니다. 게임 본체에는 별도 window.WML_GAME_UPDATER = {protocol:1, postURL, packages:[{id,label,file,html}], preserve:[]} 선언을 사용합니다. file에는 {version}을 정확히 한 번 쓰고 html은 버전 토큰 또는 고정 파일명입니다. 모더 패키지의 GAME_UPDATE.md와 examples/game-update.js를 참고하세요. 게임 계열·HTML 자체 버전·WML 런타임을 검사합니다. 저장 완료와 게임 종료를 사용자가 확인해야 설치하며 세이브·설치 모드·설정·프리셋·이미지팩은 보존합니다.
