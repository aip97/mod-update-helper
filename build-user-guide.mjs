import fs from 'node:fs';
const read = name => fs.readFileSync(new URL(name, import.meta.url));
const version = JSON.parse(read('manifest.json')).version;
const shot = (name, alt) => `<figure><img src="data:image/png;base64,${read('docs/screenshots/' + name).toString('base64')}" alt="${alt}" loading="lazy"></figure>`;
const html = `<!doctype html>
<html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>모드 업데이트 도우미 · 설치와 사용</title>
<style>
:root{color-scheme:light;--ink:#202b31;--muted:#4b5b63;--paper:#f6f5f1;--line:#d3d9d8;--accent:#29565b}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.75 system-ui,"Malgun Gothic",sans-serif}main{max-width:1000px;margin:auto;padding:40px 24px 64px}header{padding-bottom:24px;border-bottom:1px solid var(--line)}h1{font-size:30px;line-height:1.35;margin:0 0 12px}h2{font-size:22px;line-height:1.4;margin:0 0 12px}h3{font-size:17px;margin:20px 0 8px}p{margin:8px 0;max-width:75ch}.muted,figcaption{color:var(--muted);font-size:14px}nav{display:flex;gap:20px;flex-wrap:wrap;margin-top:16px}a{color:var(--accent);text-underline-offset:4px}section{padding:32px 0;border-bottom:1px solid var(--line)}figure{margin:20px 0 0}img{display:block;max-width:100%;height:auto;border:1px solid var(--line);border-radius:8px}code{font:0.95em ui-monospace,Consolas,monospace;overflow-wrap:anywhere;background:#e8eeec;padding:2px 5px;border-radius:3px}ol,ul{padding-left:24px;margin:12px 0}li{margin:8px 0}.step{font-variant-numeric:tabular-nums;color:var(--accent);margin-right:10px}details{border-top:1px solid var(--line);padding:14px 0}summary{cursor:pointer;font-weight:650}details p{margin:10px 0 0}footer{padding-top:24px;color:var(--muted);font-size:13px}a:focus-visible,summary:focus-visible{outline:3px solid var(--accent);outline-offset:4px}::selection{background:#cde0dc}body{caret-color:var(--accent)}@media(max-width:600px){main{padding:24px 16px 40px}h1{font-size:25px}section{padding:24px 0}}
</style>
<main>
<header><h1>모드 업데이트, 처음 한 번만 설정하세요.</h1>
<p>모드 업데이트 도우미 ${version} · Windows의 Chrome / Edge용</p>
<p class="muted">설치 그림은 0.7.0을 읽어 들인 Chrome 화면입니다. 모드 화면은 0.7.0 UI에 가상 모드·경로·백업을 넣은 사용 안내용 예시이며 실제 배포 버전이나 설치 결과가 아닙니다. Edge는 버튼 위치가 조금 다릅니다. 이 HTML 하나만 있어도 그림까지 볼 수 있습니다.</p>
<nav aria-label="안내 바로가기"><a href="#install">처음 설치</a><a href="#use">모드 업데이트</a><a href="#game-body">게임 본체</a><a href="#help">막혔을 때</a></nav></header>
<section id="install"><h2><span class="step">1</span>사용자용 ZIP을 풀고 실행</h2>
<p><strong>Mod-Update-Helper-User-${version}.zip</strong>을 모두 압축 해제한 뒤 <code>Install.cmd</code>를 더블클릭하세요.</p>
<p>게임을 실행하는 브라우저를 고릅니다. <strong>1 = Chrome, 2 = Edge</strong>. 도우미가 표시한 <strong>설치 폴더 경로</strong>를 기억해 주세요.</p>
<p>설치 과정에서 현재 Windows 사용자의 Chrome/Edge에 로컬 파일 연결 도우미를 등록합니다. 이후 게임 경로를 감지하면 기본으로 자동 연결합니다.</p>
<p class="muted">모더용(Modder) ZIP은 제작자를 위한 자료입니다. 일반 사용자는 User ZIP만 받으면 됩니다.</p></section>
<section><h2><span class="step">2</span>개발자 모드를 켜고 폴더 불러오기</h2>
<p>열린 확장 프로그램 화면에서 <strong>개발자 모드</strong>를 켜고 <strong>압축해제된 확장 프로그램 로드</strong>를 누르세요.</p>
<p>도우미가 알려 준 설치 폴더를 선택하세요. <code>manifest.json</code>이 들어 있는 폴더입니다.</p>
<p class="muted">화면이 안 열렸다면 주소창에 Chrome은 <code>chrome://extensions</code>, Edge는 <code>edge://extensions</code>를 입력하세요.</p>
${shot('01-load-extension.png','확장 관리 화면의 개발자 모드와 압축해제된 확장 프로그램 로드 버튼')}</section>
<section><h2><span class="step">3</span>파일 URL 접근 허용</h2>
<p><strong>모드 업데이트 도우미 → 세부정보</strong>를 열고 <strong>파일 URL에 대한 액세스 허용</strong>을 켜세요.</p>
<p>이 스위치가 켜져 있어야 내 컴퓨터의 게임을 읽을 수 있습니다.</p>
${shot('02-file-access.png','모드 업데이트 도우미 세부정보에서 켜진 파일 URL에 대한 액세스 허용')}</section>
<section id="use"><h2><span class="step">4</span>게임을 열고 활성 모드 찾기</h2>
<p>평소처럼 WML 게임을 열고, 브라우저의 <strong>확장 프로그램 버튼 → 모드 업데이트 도우미</strong>를 누르세요. 이미 실행 중인 게임도 연결할 수 있습니다.</p>
<p><strong>활성 모드</strong> 탭에서 한국어 이름·원래 이름·ID로 검색하세요. 한국어명은 모드 파일의 기존 번역을 우선하고 없으면 내장 명칭 사전을 사용합니다. 둘 다 없으면 원래 이름을 유지합니다. 게시글 주소가 없는 모드는 선택해서 <strong>모드 설정</strong>에서 제작자의 코네 게시글 주소를 저장하세요.</p>
<p><strong>모드 설정</strong>에서도 이름·ID로 검색해 선택 목록을 좁힐 수 있습니다. 목록에서 직접 선택하기 전에는 설정 대상이 바뀌지 않으며, 검색 결과가 없어도 현재 설정은 유지됩니다.</p>
<p class="muted">API 미지원이어도 주소를 직접 입력하면 됩니다. API가 주소를 제공하면 그 주소가 우선입니다.</p>
${shot('03-active-mods.png','0.7.0 Faith 예시: 한국어·영문 이름 검색, 게임 계열과 모드별 롤백 버튼')}</section>
<section><h2><span class="step">5</span>필요한 모드를 한 번에 업데이트</h2>
<ol><li><strong>업데이트 필요</strong> 탭에서 최신 버전을 확인합니다.</li>
<li>업데이트할 모드를 선택하고 자동 연결된 <strong>게임 폴더</strong>를 확인하세요. 지금 실행한 게임 HTML과 <code>wml</code> 폴더가 함께 있는 곳입니다. 다른 폴더를 쓸 때만 <strong>경로 변경</strong>을 누릅니다. 다른 계열·버전의 HTML이나 WML 폴더를 선택하면 중단합니다. 이미지팩 동봉 모드도 함께 백업·업데이트합니다.</li>
<li>처음 업데이트할 때 기본 비밀번호를 입력합니다. 이 브라우저에 저장되어 다음 실행에도 사용하며 <strong>기본 비밀번호 설정·변경</strong>으로 바꿀 수 있습니다. 잠긴 컬렉션은 파일 목록 확인에도 비밀번호가 필요합니다. 미리 정해 둔 비밀번호는 없으며, 저장값 하나를 모든 모드와 게임 본체가 공통으로 사용합니다. 미설정이면 도우미를 열 때 빈 설정창이 나타납니다. 모드와 버전을 확인하고 승인하면 순서대로 설치됩니다.</li>
<li>완료되면 게임 진행을 저장한 뒤 게임을 새로고침하세요.</li></ol>
<p class="muted">게임 실행 시 새 버전이 발견되면 업데이트 화면이 열립니다. 설치는 승인 후 진행합니다. 버전 없는 ZIP은 상태 확인 중 읽어 내부 버전을 검사합니다.</p><p>모드와 게임 본체 ZIP은 설치 전에 Windows Microsoft Defender로 검사합니다. 위협이 발견되거나 검사를 완료할 수 없으면 설치가 중단됩니다. 0.7.3 이상의 Windows 로컬 연결 도우미가 필요합니다. 검사가 모든 악성 파일의 탐지나 파일의 안전성을 보장하지는 않습니다.</p>
${shot('04-update-controls.png','0.7.0 Faith 예시: 선택한 업데이트, 감지 경로 자동 연결과 별도 경로 변경')}</section>
<section id="game-body"><h2>게임 본체도 업데이트할 수 있습니다.</h2><p>제작자가 게임 업데이트 API를 제공한 게임과 기본 연결된 Faith·Overtime 배포 글에서 새 버전을 찾습니다. 기존 모드 사용법은 그대로입니다.</p><ol><li><strong>게임 게시글 진단</strong>으로 링크와 ZIP 이름을 검사할 수 있습니다. 파일명에 버전이 없거나 규칙이 다르면 수정할 이름·다운로드 컬렉션·HTML 예상 위치를 안내합니다. <strong>게임 본체 업데이트</strong>에서 전체판·경량판을 선택하고 새 버전을 확인합니다. 처음 정한 배포판은 이 브라우저에 기억합니다.</li><li><strong>다운로드·검사</strong>를 누릅니다. ZIP과 HTML 버전을 검사한 뒤 설치 내용을 보여 줍니다.</li><li>게임을 저장하고, 다른 브라우저의 게임과 이미지 서버를 종료하세요. 저장 완료에 체크한 뒤 <strong>저장했습니다. 게임 닫고 설치</strong>를 누릅니다.</li><li>현재 브라우저의 해당 게임 폴더 HTML 탭을 닫고 백업·설치합니다. 도우미 창은 열어 두세요. 완료 후 <strong>게임 다시 열기</strong>를 누릅니다.</li></ol><p>실행하던 HTML 파일명, 세이브·설정·설치 모드·프리셋·이미지팩·생성 이미지를 보존합니다. 게임 자체의 정적 이미지와 프로그램 파일은 바뀔 수 있습니다. 모드 호환성이 달라지면 설치 확인창에 안내합니다.</p><p>본체 설치는 실행 중인 게임의 실제 경로를 사용하며 Windows 로컬 도우미가 필요합니다. 모드용 경로 변경과 별개입니다. 본체 백업은 <code>.wml-game-updater-backups/</code>에 저장됩니다. 일반 설치 오류나 도우미 창 연결 종료는 복구하지만, 전원 차단·프로세스 강제 종료의 자동 복구는 보장하지 않습니다.</p></section>
<section id="help"><h2>막혔을 때는 여기만 확인하세요.</h2>
<details><summary>활성 모드가 보이지 않아요.</summary><p>게임과 확장이 같은 브라우저에 있는지 확인하세요. 3번의 파일 URL 접근을 켠 뒤, 게임 탭을 열어 둔 상태에서 확장의 목록 새로고침을 누르세요. 다른 브라우저 프로필의 게임은 연결되지 않습니다.</p></details>
<details><summary>코네 로그인이 필요하다고 나와요.</summary><p>같은 브라우저에서 안내된 게시글을 열어 로그인한 뒤 다시 확인하세요. Kio 공유 비밀번호와 코네 로그인은 서로 다릅니다. 로그인·인증·열람 제한은 게시글 형식 오류와 구분해 안내합니다. 공개 본문을 읽을 수 있으면 로그인 없이도 진단합니다.</p></details>
<details><summary>게시글 주소를 넣었는데 업데이트가 안 떠요.</summary><p>모드 설정에서 게시글 진단을 누르세요. 제목은 자유 형식입니다. 본문 공유 링크와 컬렉션의 모드 파일명을 확인하세요. 수정이 필요한 부분은 진단 결과를 제작자에게 전달하세요.</p></details>
<details><summary>ZIP 안에 wml/mods 폴더가 없어도 되나요?</summary><p>0.5.1부터 mod.js가 ZIP 바로 안에 있거나 지원하는 모드 폴더 구조에 있어도 인식합니다. 도우미가 선택한 모드 폴더로 맞춰 적용하므로 직접 옮길 필요가 없습니다. 여러 모드가 섞였거나 ID·버전이 다르면 중단합니다.</p></details>
<details><summary>게임 폴더가 자동 연결되지 않아요.</summary><p>User ZIP의 Install.cmd로 로컬 연결 도우미까지 설치했는지 확인하세요. 도우미가 없거나 로컬 드라이브가 아닌 경로라면 <strong>경로 변경</strong>에서 폴더 접근을 허용할 수 있습니다. 이 수동 경로는 별도로 기억하며, 브라우저 권한이 만료되면 다시 허용해야 합니다. 자동 연결만으로 모드를 설치하지는 않습니다.</p></details>
<details><summary>Faith나 다른 비슷한 게임도 사용할 수 있나요?</summary><p>같은 WML 구조와 게임 식별 규약을 쓰면 계열 이름을 새로 등록하지 않아도 인식합니다. WML은 0.9.3 이상이어야 하며 모드의 지원 게임·WML 조건은 따로 검사합니다. 모드는 제작자가 해당 게임을 지원하는 ZIP을 제공해야 합니다. 게임 전체 ZIP은 별도의 게임 본체 업데이트 절차로 설치합니다. Faith·Overtime은 기존 배포 글이 기본 연결되어 있어 게임 코드를 수정하지 않아도 됩니다.</p></details>
<details><summary>WML 버전이 맞지 않는다고 나와요.</summary><p>다운로드한 모드가 현재 WML을 지원하지 않으면 설치를 중단합니다. 지원 선언이 없으면 ‘호환성 미확인’으로 표시하고 한 번 더 확인받습니다.</p></details>
<details><summary>모드를 업데이트 전으로 되돌리고 싶어요.</summary><p><strong>활성 모드 → 대상 모드의 롤백 → 게임 폴더 연결 → 업데이트 전 백업 선택 → 승인</strong> 순서로 진행하세요. 검증 가능한 해당 모드와 동봉 이미지팩의 백업만 복원하며 현재 파일도 먼저 보호 백업합니다. 게임 계열·실행한 HTML·WML 호환성이 맞지 않으면 중단합니다. 완료 후 게임을 새로고침하세요. 게임 세이브를 과거로 되돌리는 기능은 아니며 전원 중단 때 자동 복원을 보장하지 않습니다.</p></details>
<details><summary>도우미 자체는 어떻게 업데이트하나요?</summary><p>도우미 화면 상단에서 현재 버전과 업데이트 상태를 확인할 수 있습니다. 브라우저 시작 시와 주기적으로 새 버전을 확인하고, 연결된 게임을 시작할 때도 한 번 확인합니다. 기다리지 않고 확인하려면 도우미 업데이트 확인 버튼을 누르세요. 새 버전 알림이 나타나면 진행 중인 작업을 마친 뒤 <strong>도우미 업데이트 후 재시작</strong>을 누르세요. 다른 도우미 창이 열려 있으면 해당 창의 작업을 마치고 닫은 뒤 다시 시도하세요. 자동 확인은 새 버전을 알리며 설치는 업데이트 후 재시작 버튼으로 진행합니다. 게임은 자동 새로고침하지 않습니다. 0.7.3 이상의 도우미가 다음 버전으로 업데이트할 때는 서명과 ZIP 해시 확인 후 Microsoft Defender로 검사하며, 위협이 발견되거나 검사를 완료할 수 없으면 적용하지 않습니다. 0.7.2 이하에서 0.7.3으로 업데이트할 때와 최초 설치에는 이 자동 검사가 적용되지 않습니다. 저장소가 없는 개발 사본은 자동 업데이트 준비 중으로 표시합니다. 새 버전의 시작 확인이 없으면 이전 파일로 복구하며 브라우저가 확장을 비활성화한 경우 직접 다시 불러와야 할 수 있습니다.</p></details>
</section><footer>설치 도우미는 확장과 로컬 연결 도우미를 설치합니다. 모드 파일 변경은 게임 폴더를 연결하고 승인한 뒤 진행됩니다.</footer>
</main></html>`;
fs.writeFileSync(new URL('USER_GUIDE.html', import.meta.url), html + '\r\n');
console.log('Built self-contained USER_GUIDE.html with 4 current setup and fixture screens.');
