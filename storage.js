(() => {
  'use strict';
  const Studio = (globalThis.Studio = globalThis.Studio || {});
  const DB_NAME = 'desktop-studio';
  const DB_VERSION = 1;

  const dbReady = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('files')) {
        db.createObjectStore('files', { keyPath: 'name' });
      }
      if (!db.objectStoreNames.contains('parts')) {
        db.createObjectStore('parts');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  async function runTx(stores, mode, operation) {
    const db = await dbReady;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let request;
      try { request = operation(tx); }
      catch (error) { tx.abort(); reject(error); return; }
      tx.oncomplete = () => resolve(request?.result);
      tx.onabort = () => reject(tx.error || new Error('儲存中斷'));
    });
  }

  const partRange = name => IDBKeyRange.bound([name, 0], [name, Number.MAX_SAFE_INTEGER]);

  function removeFile(name) {
    return runTx(['files', 'parts'], 'readwrite', tx => {
      tx.objectStore('files').delete(name);
      return tx.objectStore('parts').delete(partRange(name));
    });
  }

  function clearAllFiles() {
    return runTx(['files', 'parts'], 'readwrite', tx => {
      tx.objectStore('files').clear();
      return tx.objectStore('parts').clear();
    });
  }

  function listFiles() {
    return runTx(['files'], 'readonly', tx => tx.objectStore('files').getAll());
  }

  function createWriter(name) {
    let index = 0;
    let size = 0;
    return {
      async write(blob) {
        await runTx(['parts', 'files'], 'readwrite', tx => {
          tx.objectStore('parts').add(blob, [name, index]);
          tx.objectStore('files').put({ name, size: size + blob.size, lastModified: Date.now(), incomplete: true });
        });
        index++;
        size += blob.size;
      },
      close(meta = {}) {
        return runTx(['files'], 'readwrite', tx =>
          tx.objectStore('files').put({
            name,
            size,
            lastModified: Date.now(),
            indexed: Boolean(meta.indexed),
            duration: meta.duration ?? null,
            savedToFolder: Boolean(meta.savedToFolder)
          })
        );
      },
      abort() {
        return removeFile(name);
      }
    };
  }

  async function saveBlobFile(name, blob, meta = {}) {
    const chunkSize = 4 * 1024 * 1024;
    await runTx(['parts', 'files'], 'readwrite', tx => {
      const parts = tx.objectStore('parts');
      parts.delete(partRange(name));
      let index = 0;
      for (let offset = 0; offset < blob.size || index === 0; offset += chunkSize) {
        parts.add(blob.slice(offset, offset + chunkSize), [name, index++]);
      }
      return tx.objectStore('files').put({
        name,
        size: blob.size,
        lastModified: meta.lastModified ?? Date.now(),
        indexed: Boolean(meta.indexed),
        duration: meta.duration ?? null,
        savedToFolder: Boolean(meta.savedToFolder)
      });
    });
  }

  async function readMedia(name) {
    const parts = await runTx(['parts'], 'readonly', tx => tx.objectStore('parts').getAll(partRange(name)));
    return new Blob(parts, { type: name.endsWith('.png') ? 'image/png' : 'video/mp4' });
  }

  async function getStorageUsage() {
    if (!navigator.storage?.estimate) return null;
    try {
      const { usage = 0, quota = 0 } = await navigator.storage.estimate();
      return { usage, quota };
    } catch {
      return null;
    }
  }

  Studio.storage = {
    dbReady,
    createWriter,
    saveBlobFile,
    readMedia,
    listFiles,
    removeFile,
    clearAllFiles,
    getStorageUsage
  };
})();
