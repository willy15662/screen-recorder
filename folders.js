(() => {
  'use strict';
  const Studio = (globalThis.Studio = globalThis.Studio || {});

  const isLocalHost = location.protocol === 'http:' && location.hostname === '127.0.0.1';
  const hashMatch = /^#folder=(\d{1,5})\.([0-9A-F]{64})$/.exec(location.hash);
  const legacySession = hashMatch ? { port: hashMatch[1], key: hashMatch[2] } : null;

  if (legacySession && history.replaceState) {
    try {
      history.replaceState(null, '', location.pathname + location.search);
    } catch {
    }
  }

  async function apiRequest(action, body) {
    if (isLocalHost) {
      const response = await fetch('/api/' + action, {
        method: 'POST',
        headers: { 'X-Studio-Client': '1' },
        body,
        credentials: 'same-origin',
        referrerPolicy: 'no-referrer'
      });
      if (!response.ok) {
        throw new Error((await response.text()) || '資料夾助手無法完成操作');
      }
      return response.text();
    }

    if (legacySession) {
      const response = await fetch('http://127.0.0.1:' + legacySession.port + '/' + action, {
        method: 'POST',
        headers: { 'X-Studio-Key': legacySession.key },
        body,
        credentials: 'omit',
        referrerPolicy: 'no-referrer'
      });
      if (!response.ok) {
        throw new Error((await response.text()) || '資料夾助手無法完成操作');
      }
      return response.text();
    }

    throw new Error('請從 Recorder.cmd 啟動桌面錄影室');
  }

  function getFolder() {
    return apiRequest('folder');
  }

  function openFolder() {
    return apiRequest('open');
  }

  function chooseFolder() {
    return apiRequest('choose');
  }

  async function saveToFolder(name, blob) {
    try {
      const path = await apiRequest('save?name=' + encodeURIComponent(name), blob);
      return { ok: true, message: '已儲存至 ' + path };
    } catch (e) {
      return {
        ok: false,
        message: '已保留在媒體庫。資料夾寫入失敗：' + e.message + '。可使用「另存檔案」。'
      };
    }
  }

  function startFolderSession(onPath, onError) {
    if (!isLocalHost && !legacySession) {
      onPath('請從 Recorder.cmd 啟動以連接資料夾');
      return;
    }
    getFolder().then(onPath).catch(e => onError(e.message));
    setInterval(() => {
      getFolder().catch(() => {});
    }, 30000);

  }

  Studio.folders = { getFolder, openFolder, chooseFolder, saveToFolder, startFolderSession };
})();
