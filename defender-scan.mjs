const CHUNK = 256 * 1024;
const hash = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');

export async function scanDownloadedZip(buffer) {
  if (!(buffer instanceof ArrayBuffer) || !buffer.byteLength || buffer.byteLength > 512 * 1024 * 1024) throw new Error('보안 검사에 사용할 ZIP 크기가 올바르지 않습니다.');
  const bytes = new Uint8Array(buffer), sha256 = await hash(bytes);
  let port, pending, nextId = 0, closed = false;
  try {
    port = chrome.runtime.connectNative('org.wml.mod_updater');
    port.onMessage.addListener(message => {
      if (!pending || message?.id !== pending.id) return;
      const current = pending; pending = null; clearTimeout(current.timer);
      if (message.ok) current.resolve(message.result);
      else current.reject(new Error(message.error || 'Windows 보안 검사가 실패했습니다.'));
    });
    port.onDisconnect.addListener(() => {
      closed = true;
      if (pending) { const current = pending; pending = null; clearTimeout(current.timer); current.reject(new Error(chrome.runtime.lastError?.message || 'Windows 보안 검사 도우미와 연결이 끊어졌습니다.')); }
    });
    const request = (op, values = {}, timeout = 30000) => new Promise((resolve, reject) => {
      if (closed) return reject(new Error('Windows 보안 검사 도우미와 연결이 끊어졌습니다.'));
      const id = ++nextId;
      const timer = setTimeout(() => { pending = null; reject(new Error('Windows 보안 검사 응답 시간이 초과되었습니다.')); }, timeout);
      pending = {id, resolve, reject, timer};
      try { port.postMessage({id,op,...values}); } catch (error) { pending = null; clearTimeout(timer); reject(error); }
    });
    const {token} = await request('scan-begin', {size:bytes.length,sha256});
    if (typeof token !== 'string' || !token) throw new Error('Windows 보안 검사 요청을 시작하지 못했습니다.');
    for (let offset = 0; offset < bytes.length; offset += CHUNK) {
      const chunk = bytes.subarray(offset, offset + CHUNK); let binary = '';
      for (let at = 0; at < chunk.length; at += 8192) binary += String.fromCharCode(...chunk.subarray(at, at + 8192));
      await request('scan-chunk', {token,data:btoa(binary)});
    }
    const result = await request('scan-finish', {token}, 600000);
    if (result?.state !== 'clean') throw new Error('Windows 보안 검사 결과를 확인할 수 없습니다.');
    if (await hash(bytes) !== sha256) throw new Error('보안 검사 중 ZIP 데이터가 변경되었습니다.');
  } catch (error) {
    throw new Error(`보안 검사 실패: ${error.message}`);
  } finally { port?.disconnect(); }
}
