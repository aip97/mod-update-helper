import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parseGameVersion, parseGameRequirement, gameMatches, supportsWmlVersion, inspectGameHTML, gameFamilyLabel} from './game-compat.mjs';

assert.deepEqual(parseGameVersion('faith-3.3.2'), {gameFamily:'faith',gameVersion:'faith-3.3.2'});
assert.deepEqual(parseGameVersion('2026-11-01'), {gameFamily:'wayward',gameVersion:'2026-11-01'});
for (const version of ['2026-02-30','2026-13-01','faith-03.3.2','faith-3.3.2-beta','faith-NaN','faith','0.9.5','Harbor-1.2.3','harbor--1.2.3','any-1.2.3','wayward-1.2.3','../harbor-1.2.3',null]) assert.throws(() => parseGameVersion(version));
for (const spec of ['faith', 'faith>=3.3.0 <faith-4.0.0','>=faith-3.3.2', 'faith-3.3.2']) {
  assert.equal(parseGameRequirement(spec).gameFamily, 'faith');
  assert.equal(gameMatches(spec, 'faith-3.3.2'), true);
  assert.equal(gameMatches(spec, '2026-11-01'), false);
}
assert.equal(gameMatches('faith>=3.9.0','faith-3.10.0'), true);
assert.equal(gameMatches('faith>=3.10.0','faith-3.9.9'), false);
assert.equal(gameMatches('>=2026-11-01','2026-11-01-pre2'), false);
assert.equal(gameMatches('>=2026-11-01-pre2 <2026-11-01','2026-11-01-pre3'), true);
assert.equal(gameMatches('wayward >=2026-10-04 <=2026-11-01','2026-11-01'), true);
assert.equal(gameMatches('*','faith-3.3.2'), true);
assert.equal(gameMatches('faith-3.3.2 || faith-3.4.0','faith-3.4.0'), true);
assert.equal(gameMatches('faith-3.3.2 || faith-3.4.0','faith-3.5.0'), false);
assert.equal(gameMatches('2026-10-04 || 2026-11-01','2026-11-01'), true);
assert.equal(gameMatches('2026-10-04 || 2026-11-01','faith-3.3.2'), false);
assert.equal(gameMatches('faith>=3.0.0 <faith-3.4.0 || faith-4.0.0','faith-3.3.2'), true);
assert.equal(gameMatches('faith>=3.0.0 <faith-3.4.0 || faith-4.0.0','faith-4.0.0'), true);
assert.equal(gameMatches('faith>=3.0.0 <faith-3.4.0 || faith-4.0.0','faith-3.4.0'), false);
for(const spec of ['faith-3.3.2 || overtime-1.0.0','faith-3.3.2 ||','|| faith-3.3.2','* || faith-3.3.2']) assert.throws(()=>parseGameRequirement(spec));
assert.equal(gameMatches('*','2026-11-01'), true);
for (const spec of ['',null,'faith wayward','>=2026-11-01 faith','* faith','faith>=03.3.2','faith^3.3.2','>=2026-02-30','>=2026-11-01 || faith','any','wayward-1.2.3','harbor-01','faith overtime']) assert.throws(() => parseGameRequirement(spec));
for (const version of ['faith-3.3.2','overtime-1.0.0','harbor-1.2.3','2026-11-01']) {
  for (const wml of ['0.9.3','0.9.6','0.10.0','1.0.0']) assert.equal(supportsWmlVersion(wml,version), true);
  for (const wml of ['0.9.2','0.8.9','1.0.0-beta','01.0.0','bad']) assert.equal(supportsWmlVersion(wml,version), false);
}
for (const family of ['overtime','harbor','harbor-town']) {
  assert.deepEqual(parseGameVersion(`${family}-1.2.3`), {gameFamily:family,gameVersion:`${family}-1.2.3`});
  for (const spec of [family, `${family}>=1.0.0 <${family}-2.0.0`, `>=${family}-1.2.3`,`${family}-1.2.3`,'*']) assert.equal(gameMatches(spec, `${family}-1.2.3`), true);
  assert.equal(gameMatches(`${family}>=1.9.0`,`${family}-1.10.0`), true);
  assert.equal(gameMatches(`${family}>=1.10.0`,`${family}-1.9.9`), false);
  assert.equal(gameMatches(family, 'faith-3.3.2'), false);
  assert.throws(() => parseGameRequirement(`${family} faith`));
}
assert.equal(gameMatches('harbor-1','harbor-1'), true);
assert.equal(gameMatches('harbor-1.0','harbor-1.0.0'),true);
assert.equal(gameMatches('harbor-1>=2.0.0','harbor-1-2.1.0'), true);
assert.equal(gameFamilyLabel('harbor'), 'harbor');
assert.equal(gameFamilyLabel('constructor'), 'constructor');

const loader = '<script src="wml/runtime/wml-core.js"></script>';
const faithful = loader + '<meta name="wf-version" content="3.3.2" />';
assert.deepEqual(inspectGameHTML(faithful), {gameFamily:'faith',gameVersion:'faith-3.3.2',htmlVersion:'faith-3.3.2'});
assert.equal(inspectGameHTML(loader + '<meta content="3.3.2" name="wf-version">').gameVersion, 'faith-3.3.2');
assert.equal(inspectGameHTML(loader + '/* WML_BRIDGE_BEGIN 2026-11-01 lang=ko */<script src="wml/symbols/2026-11-01.js"></script>').gameVersion, '2026-11-01');
for (const [family, meta, version] of [['overtime','ot-version','1.0.0'],['harbor','wml-game','harbor-1.2.3']]) {
  const expected = family === 'harbor' ? version : family + '-' + version;
  const html = loader + `<meta name="${meta}" content="${version}">`;
  assert.equal(inspectGameHTML(html).gameVersion, expected);
  assert.equal(inspectGameHTML(html + `<script src="wml/symbols/${family}-latest.js"></script>`).gameVersion, expected);
  assert.equal(inspectGameHTML(loader + `<script>WML_GAME='${expected}'; __WML__.boot({game:'${expected}',engine:{}})</script>`).gameVersion, expected);
  assert.throws(() => inspectGameHTML(html + '<meta name="wf-version" content="3.3.2">'));
  assert.throws(() => inspectGameHTML(html + '<script src="wml/symbols/faith-latest.js"></script>'));
  assert.throws(() => inspectGameHTML(html + '<meta name="wml-game" content="other-1.0.0">'));
  assert.throws(() => inspectGameHTML(html + `<script>WML_GAME='${family}-9.9.9';</script>`));
}
for (const html of [
  '<title>Wayward: Faith</title>' + loader,
  '<meta name="wf-version" content="3.3.2">',
  loader + '<script src="wml/symbols/2026-11-01.js"></script>',
  faithful + '<meta name="wf-version" content="3.3.1">',
  faithful + '<script>WML_GAME="faith-3.3.1"</script>',
  faithful + '<script src="wml/symbols/faith-3.3.1.js"></script>',
  faithful + '/* WML_BRIDGE_BEGIN 2026-11-01 */',
  loader + '/* WML_BRIDGE_BEGIN 2026-11-01 */<script>__WML__.boot({game:"2026-10-04",engine:{}})</script>',
  loader + '<meta name="harbor-version" content="1.2.3">',
  loader + '<meta name="wml-game" content="harbor--1.2.3">',
  loader + '<meta name="wml-game" content="harbor">',
  loader + '<meta name="wml-game" content="">',
  loader + '<meta name="ot-version" content="1.0.0"><meta name="wf-version" content="1.0.0">',
]) assert.throws(() => inspectGameHTML(html));

// Read the existing releases only; no game files or browser data are changed.
const realGames = [
  [new URL('../Wayward_WML_ko.html', import.meta.url), '2026-11-01'],
  [new URL('../../Wayward-WML-ko-V0.9.4/Wayward_Faith/Wayward_Faith_v3.3.2.html', import.meta.url), 'faith-3.3.2'],
];
for (const [file, expected] of realGames) if (fs.existsSync(file)) assert.equal(inspectGameHTML(fs.readFileSync(file, 'utf8')).gameVersion, expected);
console.log('Game compatibility: generic family/build contracts, future WML versions, HTML contradictions, Overtime/Harbor fixtures and available local HTML checks passed.');
