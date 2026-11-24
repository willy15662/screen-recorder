(() => {
  'use strict';
  const Studio = globalThis.Studio;
  const { indexedMp4, trimMp4 } = Studio.mp4;
  const {
    createWriter,
    saveBlobFile,
    readMedia,
    listFiles,
    removeFile,
    clearAllFiles,
    getStorageUsage
  } = Studio.storage;
  const { openFolder, chooseFolder, saveToFolder, startFolderSession } = Studio.folders;
  const { createRecorderController, releaseStream, formatClock } = Studio.recorder;

  const el = id => document.getElementById(id);
  const video = el('preview');
  const frame = el('frame');
  const stage = frame.parentElement;

  let crop = null;
  let anchor = null;
  let choosingArea = false;
  let previousCrop = null;

  let penEnabled = false;
  let strokes = [];
  let activeStroke = null;

  let camera = null;
  let cameraStream = null;
  let micPreviewStream = null;
  let micMeterCtx = null;
  let micMeterRaf = 0;
  let micRequest = 0;

  let pip = null;
  let savedURL = null;
  let selectedName = null;
  let selectedBlob = null;
  let selectionVersion = 0;

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 1024) return (bytes || 0) + ' B';
    const units = ['KB', 'MB', 'GB'];
    let val = bytes / 1024;
    let unit = 0;
    while (val >= 1024 && unit < units.length - 1) {
      val /= 1024;
      unit++;
    }
    return val.toFixed(1) + ' ' + units[unit];
  }

  function setStatus(text) {
    el('msg').textContent = text;
  }

  function refreshDimensions() {
    const display = controller.getDisplay();
    const area = crop || [0, 0, 1, 1];
    el('dimensions').textContent = display
      ? (crop ? '選取範圍' : '完整畫面') +
        '　' +
        Math.round(video.videoWidth * area[2]) +
        ' × ' +
        Math.round(video.videoHeight * area[3])
      : '尚未選取來源';
  }

  function rememberArea() {
    const display = controller.getDisplay();
    if (!display || choosingArea) return;
    localStorage.setItem(
      'lastArea',
      JSON.stringify({
        label: display.getVideoTracks()[0].label,
        width: video.videoWidth,
        height: video.videoHeight,
        crop
      })
    );
  }

  function renderBox() {
    refreshDimensions();
    const box = el('box');
    box.hidden = !crop;
    if (!crop) return;
    ['left', 'top', 'width', 'height'].forEach((key, i) => {
      box.style[key] = 100 * crop[i] + '%';
    });
  }

  function resetCrop() {
    crop = null;
    anchor = null;
    renderBox();
    rememberArea();
  }

  function redrawInk() {
    const ink = el('ink');
    const width = video.videoWidth || 1;
    const height = video.videoHeight || 1;
    if (ink.width !== width || ink.height !== height) {
      ink.width = width;
      ink.height = height;
    }
    const ctx = ink.getContext('2d');
    ctx.clearRect(0, 0, width, height);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const lineWidth = Math.max(3, width / 320);

    for (const stroke of strokes) {
      if (stroke.points.length < 2) continue;
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = lineWidth;
      ctx.beginPath();
      ctx.moveTo(stroke.points[0][0] * width, stroke.points[0][1] * height);
      for (let i = 1; i < stroke.points.length; i++) {
        ctx.lineTo(stroke.points[i][0] * width, stroke.points[i][1] * height);
      }
      ctx.stroke();
    }
    updateInkButtons();
  }

  function clearInk() {
    strokes = [];
    activeStroke = null;
    redrawInk();
  }

  function updateInkButtons() {
    const display = controller.getDisplay();
    const busy = controller.isBusy();
    el('undoInk').disabled = !display || busy || strokes.length === 0;
    el('erase').disabled = !display || busy || strokes.length === 0;
  }

  async function startCamera() {
    const camId = el('camDevice').value;
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: camId ? { deviceId: { exact: camId } } : true
    });
    camera = document.createElement('video');
    camera.muted = true;
    camera.srcObject = cameraStream;
    await camera.play();
  }

  function stopCamera() {
    releaseStream(cameraStream);
    cameraStream = null;
    if (camera) camera.srcObject = null;
    camera = null;
  }

  function drawFrame(ctx, canvas, [x, y, w, h]) {
    if (video.readyState < 2 || !video.videoWidth) return;
    ctx.drawImage(
      video,
      x * video.videoWidth,
      y * video.videoHeight,
      w * video.videoWidth,
      h * video.videoHeight,
      0,
      0,
      canvas.width,
      canvas.height
    );
    const ink = el('ink');
    if (ink.width && ink.height && strokes.length > 0) {
      ctx.drawImage(
        ink,
        x * ink.width,
        y * ink.height,
        w * ink.width,
        h * ink.height,
        0,
        0,
        canvas.width,
        canvas.height
      );
    }
    if (!camera || camera.readyState < 2 || !camera.videoWidth) return;
    const width = canvas.width * 0.22;
    const height = Math.min(canvas.height * 0.28, (width * camera.videoHeight) / camera.videoWidth);
    const actualWidth = (height * camera.videoWidth) / camera.videoHeight;
    const pad = Math.round(canvas.width * 0.018);
    const dx = el('corner').value === 'left' ? pad : canvas.width - actualWidth - pad;
    ctx.drawImage(camera, dx, canvas.height - height - pad, actualWidth, height);
  }

  function syncFloat() {
    if (!pip || pip.closed) return;
    for (const id of ['record', 'pause', 'stop', 'shot']) {
      const btn = pip.document.getElementById(id);
      if (btn) {
        btn.disabled = el(id).disabled;
        btn.textContent =
          id === 'pause' && controller.getState() === 'paused' ? '繼續' : el(id).textContent;
      }
    }
    const clockEl = pip.document.querySelector('output');
    if (clockEl) clockEl.textContent = el('clock').textContent;
  }

  function updateControls() {
    const display = controller.getDisplay();
    const active = controller.isActive();
    const busy = controller.isBusy();
    const countingDown = controller.isCountingDown();
    const locked = Boolean(active || busy);

    for (const id of [
      'source',
      'pick',
      'system',
      'mic',
      'micDevice',
      'cam',
      'camDevice',
      'corner',
      'quality',
      'fps',
      'delay',
      'limit',
      'autoFloat'
    ]) {
      el(id).disabled = locked;
    }
    for (const id of ['record', 'full']) {
      el(id).disabled = locked || !display;
    }
    el('pause').disabled = busy || !active;
    el('stop').disabled = !(active || countingDown) || (busy && !countingDown);
    el('shot').disabled = !display || busy;
    el('libraryTab').disabled = locked;
    el('expand').disabled = !display || locked;
    el('pen').disabled = !display || busy;
    el('penColor').disabled = !display || busy;
    updateInkButtons();
    refreshDimensions();
    el('pause').textContent = controller.getState() === 'paused' ? '繼續' : '暫停';
    syncFloat();
  }

  async function openFloatWindow() {
    if (!('documentPictureInPicture' in window)) {
      setStatus('目前瀏覽器不支援浮動控制列。');
      return;
    }
    try {
      if (pip && !pip.closed) {
        pip.focus();
        return;
      }
      pip = await documentPictureInPicture.requestWindow({ width: 470, height: 100 });
      const doc = pip.document;
      doc.title = '錄影控制';
      const style = doc.createElement('style');
      style.textContent =
        'body{background:#20242e;color:#ecf1f8;display:flex;align-items:center;justify-content:center;gap:7px;height:100vh;margin:0;font:15px system-ui}' +
        'button{border:1px solid #495464;border-radius:6px;padding:7px 11px;background:#303845;color:inherit;cursor:pointer}' +
        'button:disabled{opacity:.4;cursor:default}' +
        '#record{background:#ff9f93;color:#2a1516;border:0;font-weight:bold}' +
        'output{font:17px Consolas,monospace;min-width:74px}';
      doc.head.append(style);
      doc.body.append(doc.createElement('output'));
      for (const id of ['record', 'pause', 'stop', 'shot']) {
        const btn = doc.createElement('button');
        btn.id = id;
        btn.onclick = () => el(id).click();
        doc.body.append(btn);
      }
      doc.addEventListener('keydown', handleHotkeys);
      pip.addEventListener('pagehide', () => {
        pip = null;
      });
      syncFloat();
    } catch (e) {
      setStatus('無法開啟浮動控制列：' + e.message);
    }
  }

  const controller = createRecorderController({
    el,
    video,
    getCrop: () => crop,
    setCrop: next => {
      crop = next;
      renderBox();
    },
    drawFrame,
    onSourceCleared: () => {
      finishArea(false);
      clearInk();
      crop = null;
      anchor = null;
      el('box').hidden = true;
      el('hint').hidden = false;
    },
    onControlsChange: updateControls,
    onStatus: setStatus,
    onLibraryReady: (name, prepared) => showLibrary(name, prepared),
    startCamera,
    stopCamera,
    openFloatIfEnabled: openFloatWindow
  });

  function pointInVideo(e) {
    const rect = video.getBoundingClientRect();
    return [
      Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height))
    ];
  }

  frame.addEventListener('pointerdown', e => {
    if (!controller.getDisplay() || controller.isBusy()) return;
    if (penEnabled) {
      activeStroke = { color: el('penColor').value, points: [pointInVideo(e)] };
      strokes.push(activeStroke);
      frame.setPointerCapture(e.pointerId);
      return;
    }
    if (controller.isActive()) return;
    e.preventDefault();
    anchor = pointInVideo(e);
    frame.setPointerCapture(e.pointerId);
  });

  frame.addEventListener('pointermove', e => {
    if (activeStroke) {
      const p = pointInVideo(e);
      const prev = activeStroke.points[activeStroke.points.length - 1];
      activeStroke.points.push(p);
      const ink = el('ink');
      const ctx = ink.getContext('2d');
      ctx.strokeStyle = activeStroke.color;
      ctx.lineCap = 'round';
      ctx.lineWidth = Math.max(3, ink.width / 320);
      ctx.beginPath();
      ctx.moveTo(prev[0] * ink.width, prev[1] * ink.height);
      ctx.lineTo(p[0] * ink.width, p[1] * ink.height);
      ctx.stroke();
      return;
    }
    if (!anchor) return;
    const [x, y] = pointInVideo(e);
    crop = [
      Math.min(x, anchor[0]),
      Math.min(y, anchor[1]),
      Math.abs(x - anchor[0]),
      Math.abs(y - anchor[1])
    ];
    renderBox();
  });

  frame.addEventListener('pointerup', e => {
    if (activeStroke) {
      activeStroke = null;
      updateInkButtons();
      return;
    }
    if (!anchor) return;
    const [x, y] = pointInVideo(e);
    crop = [
      Math.min(x, anchor[0]),
      Math.min(y, anchor[1]),
      Math.abs(x - anchor[0]),
      Math.abs(y - anchor[1])
    ];
    anchor = null;
    if (crop[2] * video.videoWidth < 4 || crop[3] * video.videoHeight < 4) {
      crop = null;
    }
    renderBox();
    rememberArea();
  });

  frame.addEventListener('lostpointercapture', () => {
    if (activeStroke) {
      activeStroke = null;
      updateInkButtons();
    }
    if (anchor) {
      anchor = null;
    }
  });

  function finishArea(apply) {
    if (!choosingArea) return;
    choosingArea = false;
    anchor = null;
    if (!apply) crop = previousCrop;
    el('still').hidden = true;
    el('areaTools').hidden = true;
    renderBox();
    rememberArea();
    if (document.fullscreenElement === stage) {
      document.exitFullscreen().catch(() => {});
    }
  }

  el('expand').onclick = async () => {
    if (video.readyState < 2 || !video.videoWidth) {
      setStatus('畫面尚未就緒，請稍候再框選。');
      return;
    }
    setPenEnabled(false);
    previousCrop = crop;
    choosingArea = true;
    const still = el('still');
    still.width = video.videoWidth;
    still.height = video.videoHeight;
    still.getContext('2d').drawImage(video, 0, 0);
    still.hidden = false;
    el('areaTools').hidden = false;
    try {
      await stage.requestFullscreen();
    } catch {
      setStatus('請在預覽上拖曳，再按套用範圍。');
    }
  };

  el('areaDone').onclick = () => finishArea(true);
  el('areaCancel').onclick = () => finishArea(false);
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && choosingArea) finishArea(false);
  });

  function setPenEnabled(enabled) {
    penEnabled = enabled;
    activeStroke = null;
    anchor = null;
    el('pen').setAttribute('aria-pressed', String(enabled));
    frame.classList.toggle('pen-mode', enabled);
  }

  el('pen').onclick = () => {
    setPenEnabled(!penEnabled);
    setStatus(penEnabled ? '在預覽上拖曳畫線。再次按畫筆可切回框選。' : '拖曳可選取錄製範圍。');
  };

  el('undoInk').onclick = () => {
    strokes.pop();
    redrawInk();
  };

  el('erase').onclick = clearInk;
  el('full').onclick = resetCrop;
  video.addEventListener('resize', redrawInk);

  el('shot').onclick = async () => {
    try {
      if (video.readyState < 2 || !video.videoWidth) {
        throw new Error('畫面尚未就緒');
      }
      const area = crop || [0, 0, 1, 1];
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(video.videoWidth * area[2]));
      c.height = Math.max(1, Math.round(video.videoHeight * area[3]));
      drawFrame(c.getContext('2d'), c, area);
      const blob = await new Promise((resolve, reject) =>
        c.toBlob(b => (b ? resolve(b) : reject(new Error('無法產生圖片'))), 'image/png')
      );
      const name = '截圖-' + new Date().toISOString().replace(/[:.]/g, '-') + '.png';
      const out = createWriter(name);
      try {
        await out.write(blob);
        await out.close({ indexed: true });
      } catch (e) {
        await out.abort();
        throw e;
      }

      const folderResult = await saveToFolder(name, blob);
      if (folderResult.ok) await out.close({ indexed: true, savedToFolder: true });
      if (!controller.isActive() && !controller.isBusy()) {
        await showLibrary(name, blob);
      }
      setStatus(folderResult.message);
    } catch (e) {
      setStatus('截圖失敗：' + e.message);
    }
  };

  async function refreshDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      populateDeviceSelect('micDevice', devices.filter(d => d.kind === 'audioinput'), '預設麥克風');
      populateDeviceSelect('camDevice', devices.filter(d => d.kind === 'videoinput'), '預設攝影機');
    } catch {
    }
  }

  function populateDeviceSelect(selectId, devices, fallbackLabel) {
    const select = el(selectId);
    const saved = localStorage.getItem('studio-' + selectId) || select.value;
    select.replaceChildren();
    const def = document.createElement('option');
    def.value = '';
    def.textContent = fallbackLabel;
    select.append(def);
    devices.forEach((d, idx) => {
      if (!d.deviceId) return;
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `${fallbackLabel} ${idx + 1}`;
      select.append(opt);
    });
    if ([...select.options].some(o => o.value === saved)) {
      select.value = saved;
    }
  }

  function stopMicMeter() {
    micRequest++;
    cancelAnimationFrame(micMeterRaf);
    micMeterRaf = 0;
    releaseStream(micPreviewStream);
    micPreviewStream = null;
    if (micMeterCtx) {
      micMeterCtx.close().catch(() => {});
      micMeterCtx = null;
    }
    el('micBar').style.width = '0%';
  }

  async function startMicMeter() {
    stopMicMeter();
    if (!el('mic').checked) return;
    const request = micRequest;
    try {
      const micId = el('micDevice').value;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: micId ? { deviceId: { exact: micId } } : true
      });
      if (request !== micRequest) { releaseStream(stream); return; }
      micPreviewStream = stream;
      await refreshDevices();
      if (request !== micRequest) return;
      micMeterCtx = new AudioContext();
      const analyser = micMeterCtx.createAnalyser();
      analyser.fftSize = 256;
      micMeterCtx.createMediaStreamSource(micPreviewStream).connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        if (!micMeterCtx) return;
        analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (let i = 0; i < data.length; i++) {
          const v = Math.abs(data[i] - 128) / 128;
          if (v > peak) peak = v;
        }
        el('micBar').style.width = Math.min(100, Math.round(peak * 180)) + '%';
        micMeterRaf = requestAnimationFrame(tick);
      };
      tick();
    } catch (e) {
      setStatus('無法存取麥克風：' + e.message);
    }
  }

  function syncDeviceRows() {
    el('micRow').hidden = !el('mic').checked;
    el('camRow').hidden = !el('cam').checked;
    if (el('mic').checked) {
      startMicMeter();
    } else {
      stopMicMeter();
    }
  }

  function setView(library) {
    el('library').hidden = !library;
    el('studio').hidden = library;
    el('captureTab').setAttribute('aria-pressed', String(!library));
    el('libraryTab').setAttribute('aria-pressed', String(library));
    if (!library) el('playback').pause();
  }

  function clearViewer() {
    selectionVersion++;
    el('playback').pause();
    el('playback').removeAttribute('src');
    el('playback').load();
    el('photo').removeAttribute('src');
    for (const id of ['photo', 'playback', 'remove', 'download', 'copyImage', 'trimBar']) {
      el(id).hidden = true;
    }
    if (savedURL) URL.revokeObjectURL(savedURL);
    savedURL = null;
    selectedName = null;
    selectedBlob = null;
    el('empty').hidden = false;
  }

  async function selectItem(entry, prepared) {
    clearViewer();
    const version = selectionVersion;
    let blob = prepared || (await readMedia(entry.name));

    let rawOnly = Boolean(entry.incomplete);
    if (!rawOnly && !prepared && entry.name.endsWith('.mp4') && !entry.indexed) {
      try {
        setStatus('正在建立影片時間軸…');
        blob = await indexedMp4(blob);
        await saveBlobFile(entry.name, blob, {
          lastModified: entry.lastModified,
          indexed: true,
          duration: entry.duration,
          savedToFolder: entry.savedToFolder
        });
        entry.indexed = true;
        entry.size = blob.size;
      } catch { rawOnly = true; }
    }

    if (version !== selectionVersion) return;

    savedURL = URL.createObjectURL(blob);
    selectedName = entry.name;
    selectedBlob = blob;
    setStatus(rawOnly ? '錄影未完整封裝，可另存現有片段。' : '可預覽、裁切或另存檔案。');

    const isPng = /\.png$/i.test(entry.name);
    el('copyImage').hidden = !isPng || !navigator.clipboard?.write || !globalThis.ClipboardItem;
    const view = el(isPng ? 'photo' : 'playback');
    view.src = savedURL;
    view.hidden = false;
    el('empty').hidden = true;

    if (!isPng) {
      const playback = el('playback');
      playback.onloadedmetadata = () => {
        if (Number.isFinite(playback.duration) && playback.duration > 0) {
          const dur = Number(playback.duration.toFixed(1));
          el('trimStart').value = '0';
          el('trimStart').max = String(dur);
          el('trimEnd').value = String(dur);
          el('trimEnd').max = String(dur);
          el('trimBar').hidden = false;
        }
      };
    }

    const downloadLink = el('download');
    downloadLink.href = savedURL;
    downloadLink.download = entry.name;
    downloadLink.hidden = false;
    el('remove').hidden = Boolean(entry.external);

    for (const btn of el('items').children) {
      btn.setAttribute('aria-pressed', String(btn.dataset.name === entry.name));
    }
  }

  async function showLibrary(preferred, prepared) {
    setView(true);
    try {
      const entries = await listFiles();
      entries.sort((a, b) => b.lastModified - a.lastModified);

      const usage = await getStorageUsage();
      el('storageInfo').textContent = usage
        ? `媒體庫已使用 ${formatBytes(usage.usage)}`
        : `${entries.length} 個項目`;
      el('clearAll').hidden = entries.length === 0;

      const target = entries.find(f => f.name === preferred) || entries[0];
      const list = el('items');
      list.replaceChildren();

      for (const entry of entries) {
        const btn = document.createElement('button');
        btn.dataset.name = entry.name;
        btn.title = entry.name;
        const title = document.createElement('span');
        const kind = entry.name.endsWith('.png') ? '截圖' : '錄影';
        const time = new Date(entry.lastModified).toLocaleString('zh-TW', {
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        });
        title.textContent = `${kind}　${time}`;
        const meta = document.createElement('small');
        const parts = [formatBytes(entry.size), entry.savedToFolder ? '已輸出' : '未確認有資料夾副本'];
        if (entry.incomplete) parts.push('未完成');
        if (entry.duration) parts.push(formatClock(entry.duration));
        meta.textContent = parts.join(' · ');
        btn.append(title, meta);
        btn.onclick = () => selectItem(entry).catch(e => setStatus(e.message));
        list.append(btn);
      }

      if (target) {
        await selectItem(target, target.name === preferred ? prepared : undefined);
      } else {
        clearViewer();
      }
    } catch (e) {
      setStatus('無法讀取媒體庫：' + e.message);
    }
  }

  el('trimExport').onclick = async () => {
    if (!selectedBlob || !selectedName) return;
    const start = Number(el('trimStart').value);
    const end = Number(el('trimEnd').value);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      setStatus('請輸入有效的裁切起訖秒數。');
      return;
    }
    el('trimExport').disabled = true;
    setStatus('正在裁切影片…');
    try {
      const trimmed = await trimMp4(selectedBlob, start, end);
      const outName = '錄影-' + new Date().toISOString().replace(/[:.]/g, '-') + '.mp4';
      const folderResult = await saveToFolder(outName, trimmed);
      await saveBlobFile(outName, trimmed, {
        indexed: true,
        duration: end - start,
        savedToFolder: folderResult.ok
      });
      await showLibrary(outName, trimmed);
      setStatus('裁切完成。' + folderResult.message);
    } catch (e) {
      setStatus('裁切失敗：' + e.message);
    } finally {
      el('trimExport').disabled = false;
    }
  };

  el('copyImage').onclick = async () => {
    if (selectedBlob?.type !== 'image/png') return;
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': selectedBlob })]);
      setStatus('已複製截圖。');
    } catch (e) { setStatus('無法複製截圖：' + e.message); }
  };
  el('remove').onclick = async () => {
    if (!selectedName || !confirm('從本機媒體庫移除這份檔案？未另存的項目將無法復原。')) return;
    try {
      await removeFile(selectedName);
      await showLibrary();
    } catch (e) {
      setStatus(e.message);
    }
  };

  el('clearAll').onclick = async () => {
    if (!confirm('確定要清空本機媒體庫的全部項目？未另存的項目將無法復原。')) return;
    try {
      await clearAllFiles();
      await showLibrary();
      setStatus('已清空本機媒體庫。');
    } catch (e) {
      setStatus(e.message);
    }
  };

  el('source').onclick = () => controller.pickSource();
  el('pick').onclick = () => controller.pickSource();
  el('record').onclick = () => controller.startRecording();
  el('pause').onclick = () => controller.togglePause();
  el('stop').onclick = () => controller.stopRecording();
  el('float').onclick = openFloatWindow;
  el('openMedia').onclick = () => el('mediaInput').click();
  el('mediaInput').onchange = async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!/\.(mp4|png)$/i.test(file.name)) { setStatus('請選擇 MP4 或 PNG 檔案。'); return; }
    try {
      await selectItem({ name: file.name, indexed: true, external: true }, file);
      setStatus('已開啟磁碟檔案。裁切會另存為新影片。');
    } catch (error) { setStatus('無法開啟檔案：' + error.message); }
  };
  el('libraryTab').onclick = () => showLibrary();
  el('captureTab').onclick = el('back').onclick = () => setView(false);

  el('system').onchange = () => {
    const display = controller.getDisplay();
    if (el('system').checked && display && !display.getAudioTracks().length) {
      setStatus('請重新選擇畫面並勾選分享音訊。');
    }
  };

  el('mic').addEventListener('change', syncDeviceRows);
  el('cam').addEventListener('change', () => {
    syncDeviceRows();
    if (el('cam').checked) refreshDevices();
  });
  el('micDevice').addEventListener('change', () => {
    if (el('mic').checked) startMicMeter();
  });

  const prefIds = [
    'system',
    'mic',
    'micDevice',
    'cam',
    'camDevice',
    'corner',
    'quality',
    'fps',
    'delay',
    'limit',
    'autoFloat'
  ];
  for (const id of prefIds) {
    const input = el(id);
    const key = 'studio-' + id;
    const saved = localStorage.getItem(key);
    if (saved !== null) {
      if (input.type === 'checkbox') input.checked = saved === 'true';
      else input.value = saved;
    }
    input.addEventListener('change', () => {
      localStorage.setItem(key, input.type === 'checkbox' ? String(input.checked) : input.value);
    });
  }

  async function runFolderAction(fn, pendingMsg, doneMsg) {
    el('folderOpen').disabled = el('folderChoose').disabled = true;
    const prevPath = el('folderPath').textContent;
    if (pendingMsg) setStatus(pendingMsg);
    try {
      const path = await fn();
      if (path) el('folderPath').textContent = path;
      if (doneMsg) setStatus(doneMsg(path, prevPath));
    } catch (e) {
      setStatus('無法連接儲存資料夾：' + e.message + '。可重新啟動 Recorder.cmd。');
    } finally {
      el('folderOpen').disabled = el('folderChoose').disabled = false;
    }
  }

  el('folderOpen').onclick = () =>
    runFolderAction(openFolder, '正在開啟儲存資料夾…', () => '已開啟儲存資料夾。');
  el('folderChoose').onclick = () =>
    runFolderAction(
      chooseFolder,
      '已開啟資料夾選擇視窗，請在彈出視窗中選取資料夾…',
      (next, prev) => (next && next !== prev ? '儲存位置已更新為 ' + next : '未變更儲存位置。')
    );

  startFolderSession(
    path => {
      el('folderPath').textContent = path;
    },
    err => {
      setStatus('無法連接儲存資料夾：' + err + '。可重新啟動 Recorder.cmd。');
    }
  );

  function handleHotkeys(e) {
    if (e.repeat) return;
    if (e.key === 'Escape' && controller.isCountingDown()) {
      e.preventDefault();
      controller.stopRecording();
      return;
    }
    if (controller.isActive() && (e.key === 'F8' || e.key === 'F9')) {
      e.preventDefault();
      el(e.key === 'F8' ? 'pause' : 'stop').click();
    }
  }

  document.addEventListener('keydown', handleHotkeys);
  new MutationObserver(syncFloat).observe(el('clock'), { childList: true });

  window.addEventListener('beforeunload', e => {
    if (controller.isActive() || controller.isBusy()) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  if (!('documentPictureInPicture' in window)) {
    el('float').hidden = true;
    el('autoFloat').closest('label').hidden = true;
  }

  refreshDevices();
  syncDeviceRows();
  updateControls();
  if (location.hash === '#library') showLibrary();
})();
