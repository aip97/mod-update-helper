const number = '(?:0|[1-9]\\d{0,5})';
const familyPattern = '[a-z][a-z0-9]*(?:-[a-z0-9]+)*';
const familyName = new RegExp(`^${familyPattern}$`);
const semanticVersion = new RegExp(`^(${familyPattern})-(${number}(?:\\.${number})*)$`);
const prefixRequirement = new RegExp(`^(${familyPattern})(>=|<=|>|<|=)-?(\\d+(?:\\.\\d+)*)$`);
const suffixRequirement = new RegExp(`^(>=|<=|>|<|=)?(${familyPattern})-(\\d+(?:\\.\\d+)*)$`);
const wmlVersionPattern = new RegExp(`^(${number})\\.(${number})\\.(${number})$`);
const datedVersion = /^(\d{4}-\d{2}-\d{2})(?:-([a-z][a-z0-9.]*))?$/;
const need = (ok, message) => { if (!ok) throw new Error(message); };
function checkFamily(family) {
  need(typeof family === 'string' && family.length <= 64 && familyName.test(family) && family !== 'any', '게임 계열 식별자가 올바르지 않습니다.');
}

export function parseGameVersion(value) {
  need(typeof value === 'string' && value.length <= 64, '게임 빌드 버전 형식을 확인할 수 없습니다.');
  const semantic = semanticVersion.exec(value);
  if (semantic) {
    checkFamily(semantic[1]);
    need(semantic[1] !== 'wayward', '일반 WML는 날짜 형식의 게임 빌드를 사용합니다.');
    return { gameFamily: semantic[1], gameVersion: value };
  }
  const date = datedVersion.exec(value);
  need(date && Number(date[1].slice(0, 4)) >= 1000 && !Number.isNaN(Date.parse(date[1])) && new Date(date[1]).toISOString().slice(0, 10) === date[1], '게임 빌드 버전 형식을 확인할 수 없습니다.');
  return { gameFamily: 'wayward', gameVersion: value };
}

function requirementPart(part) {
  let match = prefixRequirement.exec(part);
  if (match) return { ...parseGameVersion(match[1] + '-' + match[3]), operator: match[2] || '=' };
  match = suffixRequirement.exec(part);
  if (match) return { ...parseGameVersion(match[2] + '-' + match[3]), operator: match[1] || '=' };
  match = /^(>=|<=|>|<|=)?(\d{4}-\d{2}-\d{2}(?:-[a-z][a-z0-9.]*)?)$/.exec(part);
  if (match) return { ...parseGameVersion(match[2]), operator: match[1] || '=' };
  checkFamily(part);
  return {gameFamily:part};
}

export function parseGameRequirement(spec) {
  need(typeof spec === 'string' && spec.trim() && spec.length <= 256, '게임 호환 범위를 확인할 수 없습니다.');
  const gameSpec = spec.trim();
  if (gameSpec === '*') return { gameFamily: 'any', gameSpec };
  const families = new Set(gameSpec.split(/\s+/).map(part => requirementPart(part).gameFamily));
  need(families.size === 1, '서로 다른 게임 계열의 조건을 한 게임 범위에 혼합할 수 없습니다.');
  return { gameFamily: [...families][0], gameSpec };
}

function gameKey(version) {
  const semantic = semanticVersion.exec(version);
  if (semantic) return semantic[2].split('.').map(n => n.padStart(6, '0')).join('.').replace(/(?:\.000000)+$/, '');
  const [, date, suffix] = datedVersion.exec(version);
  return date + (suffix ? ' ' + suffix.replace(/\d+/g,n=>n.padStart(6,'0')) : '~');
}
export function compareGameVersions(a,b) {
  need(parseGameVersion(a).gameFamily===parseGameVersion(b).gameFamily,'서로 다른 게임 버전은 비교할 수 없습니다.');
  const aa=gameKey(a),bb=gameKey(b);return aa===bb?0:aa>bb?1:-1;
}

export function gameMatches(spec, version) {
  const current = parseGameVersion(version), required = parseGameRequirement(spec);
  if (required.gameFamily === 'any') return true;
  if (required.gameFamily !== current.gameFamily) return false;
  const key = gameKey(version);
  return required.gameSpec.split(/\s+/).every(part => {
    const { gameVersion, operator } = requirementPart(part);
    if (!gameVersion) return true;
    const other = gameKey(gameVersion);
    return operator === '>=' ? key >= other : operator === '<=' ? key <= other : operator === '>' ? key > other : operator === '<' ? key < other : key === other;
  });
}

export function supportsWmlVersion(wmlVersion, gameVersion) {
  parseGameVersion(gameVersion);
  const version = typeof wmlVersion === 'string' && wmlVersionPattern.exec(wmlVersion);
  return !!version && (+version[1] > 0 || +version[2] > 9 || (+version[2] === 9 && +version[3] >= 3));
}

export function gameFamilyLabel(family) {
  const labels = { wayward: '일반 WML', faith: 'Faith', overtime: 'Overtime', any: '모든 게임 계열 공용' };
  return Object.hasOwn(labels, family) ? labels[family] : typeof family === 'string' && familyName.test(family) ? family : '미확인';
}

export function inspectGameHTML(text) {
  need(typeof text === 'string', '게임 HTML을 읽을 수 없습니다.');
  const scripts = [...text.matchAll(/<script\b[^>]*\bsrc\s*=\s*(["'])([^"']+)\1[^>]*>/gi)].map(match => match[2]);
  need(scripts.some(src => /^(?:\.\/)?wml\/runtime\/wml-core\.js$/.test(src)), '선택한 HTML에 WML 로더 연결이 없습니다.');
  const versions = [];
  for (const match of text.matchAll(/\/\*\s*WML_BRIDGE_BEGIN\s+(\S+)/g)) versions.push(match[1]);
  for (const match of text.matchAll(/\b(?:globalThis\.|window\.)?WML_GAME\s*=\s*(["'])([^"']+)\1/g)) versions.push(match[2]);
  for (const match of text.matchAll(/\b(?:__WML__|WML)\s*\.\s*boot\s*\(\s*\{\s*game\s*:\s*(["'])([^"']+)\1\s*[,}]/g)) versions.push(match[2]);
  for (const match of text.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = Object.fromEntries([...match[0].matchAll(/([\w-]+)\s*=\s*(["'])(.*?)\2/g)].map(value => [value[1].toLowerCase(), value[3]]));
    const name = attributes.name?.toLowerCase();
    if (name === 'wml-game') { need(attributes.content, '게임 HTML 버전이 없습니다.'); versions.push(attributes.content); }
    const family = name === 'wf-version' ? 'faith' : name === 'ot-version' ? 'overtime' : null;
    if (family) { need(attributes.content, `${gameFamilyLabel(family)} HTML 버전이 없습니다.`); versions.push(family + '-' + attributes.content); }
  }
  need(versions.length, 'HTML 자체의 게임 빌드 버전을 확인할 수 없습니다.');
  const symbolFamilies = [];
  for (const src of scripts) {
    const match = /^(?:\.\/)?wml\/symbols\/([^/]+)\.js$/.exec(src);
    if (!match) continue;
    const alias = new RegExp(`^(${familyPattern})-latest$`).exec(match[1]);
    if (alias) symbolFamilies.push(alias[1]); else versions.push(match[1]);
  }
  versions.forEach(parseGameVersion);
  need(new Set(versions).size === 1, 'HTML의 게임 버전·WML 연결·심볼 빌드가 서로 다릅니다.');
  const info = parseGameVersion(versions[0]);
  need(symbolFamilies.every(family => family === info.gameFamily), 'HTML과 심볼 파일의 게임 계열이 다릅니다.');
  return { ...info, htmlVersion: info.gameVersion };
}
