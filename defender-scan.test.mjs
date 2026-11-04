import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {scanDownloadedZip} from './defender-scan.mjs';

let mode = 'clean', disconnected = false, requests = [], input;
globalThis.chrome = {runtime:{connectNative(name) {
  assert.equal(name, 'org.wml.mod_updater');
  let onMessage, onDisconnect, metadata, pieces = [];
  return {
    onMessage:{addListener(fn){onMessage = fn;}}, onDisconnect:{addListener(fn){onDisconnect = fn;}},
    disconnect(){disconnected = true; onDisconnect();},
    postMessage(request) {
      requests.push(request.op);
      queueMicrotask(() => {
        if (request.op === 'scan-begin') metadata = request;
        if (request.op === 'scan-chunk') pieces.push(Buffer.from(request.data, 'base64'));
        if (request.op === 'scan-finish') {
          const joined = Buffer.concat(pieces);
          assert.equal(joined.length, metadata.size);
          assert.equal(createHash('sha256').update(joined).digest('hex'), metadata.sha256);
          if (mode === 'mutated') new Uint8Array(input)[0] ^= 1;
        }
        onMessage({id:request.id, ok:mode !== 'threat' || request.op !== 'scan-finish', error:'위협이 발견되었습니다',
          result:request.op === 'scan-begin' ? {token:'test-token'} : request.op === 'scan-finish' ? {state:mode === 'unknown' ? 'unknown' : 'clean'} : {}});
      });
    },
  };
}}};

input = new Uint8Array(256 * 1024 + 3).fill(42).buffer;
await scanDownloadedZip(input);
assert.deepEqual(requests, ['scan-begin','scan-chunk','scan-chunk','scan-finish']);
assert.equal(disconnected, true);
for (mode of ['threat','unknown','mutated']) {
  disconnected = false; requests = []; input = new Uint8Array([1,2,3]).buffer;
  await assert.rejects(scanDownloadedZip(input), /보안 검사 실패/);
  assert.equal(disconnected, true, 'failed scans close the native connection');
}
await assert.rejects(scanDownloadedZip(new ArrayBuffer(0)), /크기/);
delete globalThis.chrome;
console.log('Defender scan: chunked exact bytes, threat/unknown rejection, mutation guard, and connection cleanup passed.');
