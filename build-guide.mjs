import fs from 'node:fs';
const read = name => fs.readFileSync(new URL(name, import.meta.url), 'utf8');
const escape = value => value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const picture = name => 'data:image/jpeg;base64,' + fs.readFileSync(new URL('docs/screenshots/' + name, import.meta.url)).toString('base64');
const bridge = read('examples/bridge.js');
const example = "WML.define({\n  id: 'my-mod',\n  name: '내 모드',\n  version: '1.0.0',\n  game: '>=2026-11-01',\n  wml: ['0.9.4', '0.9.5'],\n  setup(api) {\n" + bridge.trimEnd().split('\n').map(line => line ? '    ' + line : '').join('\n') + '\n  },\n});\n';
fs.writeFileSync(new URL('examples/mod.js', import.meta.url), example);
const html = read('GUIDE.template.html').replace('__BRIDGE__', escape(bridge)).replace('__MOD__', escape(example)).replace('__POST__', escape(read('examples/release-post.txt')))
  .replace('__GAME_API__', escape(read('examples/game-update.js')))
  .replace('__RELEASE_POST_TITLE_IMAGE__', picture('05-release-post-title.jpg'))
  .replace('__RELEASE_POST_DOWNLOAD_IMAGE__', picture('06-release-post-download.jpg'));
fs.writeFileSync(new URL('GUIDE.html', import.meta.url), html.trimEnd() + '\n');
console.log('Built standalone guide and complete mod example');

fs.writeFileSync(new URL('skills/wml-updater-integration/references/game-update.md',import.meta.url),read('GAME_UPDATE.md'));
fs.writeFileSync(new URL('skills/wml-updater-integration/assets/game-update.js',import.meta.url),read('examples/game-update.js'));
