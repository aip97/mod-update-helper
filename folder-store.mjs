function folderKey(gameURL) {
  if (typeof gameURL !== 'string') throw new Error('게임 파일 URL이 필요합니다.');
  const url = new URL(gameURL);
  if (url.protocol !== 'file:' || url.pathname.endsWith('/')) throw new Error('로컬 게임 파일 URL이 필요합니다.');
  return new URL('.', url).href;
}

async function access(gameURL, handle) {
  const key = folderKey(gameURL);
  if (handle !== undefined && handle !== null && (typeof FileSystemDirectoryHandle === 'undefined' || !(handle instanceof FileSystemDirectoryHandle))) {
    throw new Error('게임 폴더 핸들이 필요합니다.');
  }
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('wml-mod-updater-folders', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('folders');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction('folders', handle === undefined ? 'readonly' : 'readwrite');
      const store = transaction.objectStore('folders');
      const request = handle === undefined ? store.get(key) : handle === null ? store.delete(key) : store.put(handle, key);
      transaction.oncomplete = () => resolve(handle === undefined ? request.result ?? null : undefined);
      transaction.onabort = () => reject(transaction.error || new Error('게임 폴더 저장을 완료하지 못했습니다.'));
      transaction.onerror = () => reject(transaction.error);
    });
  } finally { db.close(); }
}

export function loadGameFolder(gameURL) { return access(gameURL); }
export function forgetGameFolder(gameURL) { return access(gameURL, null); }
export function saveGameFolder(gameURL, handle) {
  if (!handle) return Promise.reject(new Error('게임 폴더 핸들이 필요합니다.'));
  return access(gameURL, handle);
}
