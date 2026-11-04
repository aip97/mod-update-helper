const HOST = 'org.wml.mod_updater';
const CHUNK = 256 * 1024;
const unavailable = detail => new Error(`게임 경로 자동 연결을 사용할 수 없습니다. 0.6.0 이상 버전의 Install.cmd로 Windows 도우미를 설치하거나 ‘경로 변경’으로 폴더를 연결해 주세요.${detail ? ` (${detail})` : ''}`);

export async function connectNativeGameFolder(gameURL) {
  const url = new URL(gameURL);
  // shortcut: local Windows drives only; validate UNC roots before enabling network shares.
  if (url.protocol !== 'file:' || url.hostname || !/^\/[A-Za-z]:\/.+\.html?$/i.test(url.pathname)) throw unavailable('로컬 Windows 드라이브만 지원');
  let port;
  try { port = chrome.runtime.connectNative(HOST); } catch (error) { throw unavailable(error.message); }
  let nextId = 0, closed = false;
  const pending = new Map();
  const disconnect = () => { closed = true; port.disconnect(); for (const {reject, timer} of pending.values()) { clearTimeout(timer); reject(unavailable('연결 종료')); } pending.clear(); };
  port.onDisconnect.addListener(() => {
    closed = true;
    const error = unavailable(chrome.runtime.lastError?.message || 'Windows 도우미 연결 종료');
    for (const {reject, timer} of pending.values()) { clearTimeout(timer); reject(error); }
    pending.clear();
  });
  port.onMessage.addListener(message => {
    const waiting = pending.get(message?.id);
    if (!waiting) return;
    pending.delete(message.id); clearTimeout(waiting.timer);
    if (message.ok) waiting.resolve(message.result);
    else waiting.reject(Object.assign(new Error(message.error || 'Windows 파일 작업 실패'), {name: message.name || 'Error'}));
  });
  const request = (op, values = {}) => new Promise((resolve, reject) => {
    if (closed) { reject(unavailable('연결 종료')); return; }
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(unavailable('응답 시간 초과')); disconnect(); }, 30000);
    pending.set(id, {resolve, reject, timer});
    try { port.postMessage({id, op, ...values}); } catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
  });
  const join = (path, name) => {
    if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[\\/]/.test(name)) throw new TypeError('파일 이름이 올바르지 않습니다.');
    return path ? `${path}/${name}` : name;
  };
  const createNewFile = async (path, bytes) => {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > 16 * 1024 * 1024) throw new Error('신규 파일 크기가 허용 범위를 벗어났습니다.');
    const {token} = await request('begin-new', {path});
    try {
      for (let offset = 0; offset < bytes.length; offset += CHUNK) {
        const chunk = bytes.subarray(offset, offset + CHUNK); let binary = '';
        for (let at = 0; at < chunk.length; at += 8192) binary += String.fromCharCode(...chunk.subarray(at, at + 8192));
        await request('chunk', {token, data:btoa(binary)});
      }
      await request('commit', {token});
    } catch (error) { await request('abort', {token}).catch(() => {}); throw error; }
  };
  const beginNewMod = async modId => {
    const {token,stage} = await request('new-mod-begin', {modId});
    const prefix = `.wml-mod-updater-backups/${modId}/.wiki-stage-`;
    if (typeof token !== 'string' || typeof stage !== 'string' || !stage.startsWith(prefix) || !/^[a-f0-9]{32}$/.test(stage.slice(prefix.length))) throw new Error('모드 설치 준비 경로를 확인하지 못했습니다.');
    return {stage, publish:()=>request('new-mod-publish',{token}), abort:()=>request('new-mod-abort',{token})};
  };
  const fileData = (path, info, start = 0, end = info.size) => ({
    size: end - start,
    slice(from = 0, to = end - start) {
      const size = end - start;
      const clamp = value => Math.min(size, Math.max(0, value < 0 ? size + value : value));
      const first = clamp(Math.trunc(from)), last = Math.max(first, clamp(Math.trunc(to)));
      return fileData(path, info, start + first, start + last);
    },
    async arrayBuffer() {
      const result = new Uint8Array(end - start);
      for (let offset = start; offset < end; offset += CHUNK) {
        const length = Math.min(CHUNK, end - offset);
        const reply = await request('read', {path, offset, length, size: info.size, stamp: info.stamp});
        const binary = atob(reply.data);
        if (binary.length !== length) throw new Error('Windows 파일 읽기 크기가 다릅니다.');
        for (let i = 0; i < length; i++) result[offset - start + i] = binary.charCodeAt(i);
      }
      return result.buffer;
    },
    async text() { return new TextDecoder().decode(await this.arrayBuffer()); },
  });
  const entry = (path, kind) => ({
    kind, name: path.split('/').at(-1), native: true,
    async queryPermission() { return closed ? 'denied' : 'granted'; },
    ...(kind === 'directory' ? {
      async getDirectoryHandle(name, {create = false} = {}) {
        const child = join(path, name); await request('stat', {path:child, kind:'directory', create}); return entry(child, 'directory');
      },
      async getFileHandle(name, {create = false} = {}) {
        const child = join(path, name); await request('stat', {path:child, kind:'file', create}); return entry(child, 'file');
      },
      async *values() {
        const {entries} = await request('list', {path});
        for (const item of entries) yield entry(join(path, item.name), item.kind);
      },
      async removeEntry(name, options = {}) {
        if (options.recursive) throw new Error('재귀 삭제는 지원하지 않습니다.');
        await request('remove', {path: join(path, name)});
      },
    } : {
      async getFile() { return fileData(path, await request('stat', {path, kind:'file'})); },
      async createWritable() {
        const {token} = await request('begin', {path}); let written = false, done = false;
        return {
          async write(value) {
            if (done || written) throw new Error('한 번의 전체 파일 쓰기만 지원합니다.');
            const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value instanceof Blob ? new Uint8Array(await value.arrayBuffer()) : value instanceof ArrayBuffer ? new Uint8Array(value) : value;
            if (!(bytes instanceof Uint8Array) || bytes.byteLength > 64 * 1024 * 1024) throw new Error('파일 쓰기 크기가 허용 범위를 벗어났습니다.');
            written = true;
            for (let offset = 0; offset < bytes.length; offset += CHUNK) {
              const chunk = bytes.subarray(offset, offset + CHUNK); let binary = '';
              for (let at = 0; at < chunk.length; at += 8192) binary += String.fromCharCode(...chunk.subarray(at, at + 8192));
              await request('chunk', {token, data: btoa(binary)});
            }
          },
          async close() { if (done) throw new Error('파일 쓰기가 이미 끝났습니다.'); await request('commit', {token}); done = true; },
          async abort() { if (!done) { await request('abort', {token}); done = true; } },
        };
      },
    }),
  });
  try {
    const game = await request('connect', {url: url.href});
    return {...entry('', 'directory'), name:game.name, gameFile:game.gameFile, path:game.path, disconnect, createNewFile, beginNewMod,
      authorizeGameUpdate:(paths,backupPath)=>request('game-authorize',{paths,backupPath}),
      armGameUpdate:()=>request('game-arm'),finishGameUpdate:()=>request('game-finish')};
  } catch (error) { disconnect(); throw error; }
}
