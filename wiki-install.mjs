import {inspectPackage, inspectGameRoot, evaluateCompatibility, readOptional} from './installer.mjs';
import {validateModId} from './core.mjs';

const equal = (left, right) => left?.length === right.length && left.every((byte, i) => byte === right[i]);
const need = (ok, message, extra = {}) => { if (!ok) throw Object.assign(new Error(message), extra); };

async function ensureParent(root, path) {
  const parts = path.split('/'); parts.pop();
  let directory = root;
  for (const part of parts) directory = await directory.getDirectoryHandle(part, {create:true});
}

export async function ensureNewFolder(root, modId) {
  validateModId(modId);
  try {
    const mods = await (await root.getDirectoryHandle('wml')).getDirectoryHandle('mods');
    try { await mods.getDirectoryHandle(modId); }
    catch (error) { if (error.name === 'NotFoundError') return; throw error; }
    throw new Error('같은 이름의 모드 폴더가 이미 있습니다. 비활성 모드일 수 있으니 게임에서 모드를 활성화한 뒤 모드 업데이트 탭을 이용해 주세요.');
  } catch (error) {
    if (error.name !== 'NotFoundError') throw error;
  }
}

export async function installNewMod(root, zipBytes, {modId, expectedVersion, gameFile, expectedGame, allowUnknownWml = false} = {}) {
  need(root?.native && typeof root.createNewFile === 'function' && typeof root.beginNewMod === 'function', '새 모드 설치에는 최신 Windows 설치 도우미 자동 연결이 필요합니다.');
  need(typeof modId === 'string' && typeof expectedVersion === 'string' && typeof gameFile === 'string' && expectedGame?.gameVersion && expectedGame?.wmlVersion, '선택한 모드와 실행 중인 게임 버전을 다시 확인해 주세요.');
  const pkg = await inspectPackage(zipBytes, expectedVersion, modId);
  const game = await inspectGameRoot(root, {gameFile});
  const sameGame = current => current.gameVersion === expectedGame.gameVersion && current.wmlVersion === expectedGame.wmlVersion && (expectedGame.htmlVersion === undefined || current.htmlVersion === expectedGame.htmlVersion);
  need(sameGame(game), '실행 중인 게임과 설치 폴더의 버전이 다릅니다.');
  const compatibility = evaluateCompatibility(pkg, game.wmlVersion, game.gameVersion);
  need(compatibility.gameState !== 'unsupported', '이 모드는 현재 게임과 호환되지 않습니다.', {code:'GAME_INCOMPATIBLE', ...compatibility});
  need(compatibility.state === 'supported' || (compatibility.state === 'unknown' && allowUnknownWml), compatibility.state === 'unknown' ? 'WML 호환 정보가 없습니다. 별도 확인이 필요합니다.' : '이 모드는 현재 WML 버전과 호환되지 않습니다.', {code:compatibility.state === 'unknown' ? 'WML_COMPAT_UNKNOWN' : 'WML_INCOMPATIBLE', ...compatibility});
  await ensureNewFolder(root, modId);
  const reused = [], fresh = [];
  for (const file of pkg.files) {
    const existing = await readOptional(root, file.path);
    if (existing === null) fresh.push(file);
    else {
      need(file.path.startsWith('image-packs/') && equal(existing, file.data), `이미 존재하는 파일과 충돌합니다: ${file.path}`);
      reused.push(file);
    }
  }
  need(sameGame(await inspectGameRoot(root, {gameFile})), '설치 준비 중 게임 버전이 변경되었습니다.');
  await ensureNewFolder(root, modId);
  const prefix = `wml/mods/${modId}/`, modPath = prefix + 'mod.js', written = [];
  await ensureParent(root, prefix.slice(0,-1));
  const stage = await root.beginNewMod(modId);
  let attempted, publishing = false;
  try {
    for (const file of [...fresh].sort((a,b) => Number(a.path === modPath) - Number(b.path === modPath))) {
      const target = file.path.startsWith(prefix) ? `${stage.stage}/${file.path.slice(prefix.length)}` : file.path;
      await ensureParent(root, target);
      attempted = target;
      await root.createNewFile(target, file.data);
      written.push(target); attempted = null;
      need(equal(await readOptional(root, target), file.data), `설치한 파일을 확인하지 못했습니다: ${file.path}`);
    }
    for (const file of reused) need(equal(await readOptional(root, file.path), file.data), `기존 이미지팩이 설치 중 변경되었습니다: ${file.path}`);
    need(sameGame(await inspectGameRoot(root, {gameFile})), '설치 중 게임 버전이 변경되었습니다.');
    publishing = true;
    await stage.publish();
  } catch (error) {
    const images = [...new Set([...written, attempted].filter(path => path?.startsWith('image-packs/')))];
    let stageMayRemain = false;
    try { await stage.abort(); } catch { stageMayRemain = true; }
    const outcome = publishing ? '설치 결과가 불확실합니다. 모드 폴더를 확인해 주세요.' : '모드 설치가 완료되지 않았습니다.';
    const imageNote = images.length ? ` 이미지팩을 삭제하지 않았습니다. 확인할 경로: ${images.join(', ')}.` : '';
    const stageNote = stageMayRemain ? ` 임시 폴더가 남았을 수 있습니다: ${stage.stage}.` : '';
    throw new Error(`${error.message} ${outcome}${imageNote}${stageNote}`);
  }
  return {version:pkg.version, filesWritten:written.length, filesReused:reused.length, needsModListRefresh:true};
}
