(() => {
  'use strict';
  const Studio = (globalThis.Studio = globalThis.Studio || {});
  const { indexedMp4 } = Studio.mp4;
  const { dbReady, createWriter, readMedia, saveBlobFile } = Studio.storage;
  const { saveToFolder } = Studio.folders;

  function formatClock(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds));
    return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60]
      .map(n => String(n).padStart(2, '0'))
      .join(':');
  }

  function releaseStream(stream) {
    stream?.getTracks().forEach(track => track.stop());
  }

  function createRecorderController(deps) {
    const {
      el,
      video,
      getCrop,
      setCrop,
      drawFrame,
      onSourceCleared,
      onControlsChange,
      onStatus,
      onLibraryReady,
      startCamera,
      stopCamera,
      openFloatIfEnabled
    } = deps;

    let display = null;
    let microphone = null;
    let audioContext = null;
    let canvasStream = null;
    let drawTimer = null;
    let recorder = null;
    let busy = false;
    let countingDown = false;
    let countdownAbort = null;
    let started = 0;
    let elapsed = 0;
    let lastClockText = '00:00:00';

    const isActive = () => Boolean(recorder && recorder.state !== 'inactive');
    const isBusy = () => busy;
    const isCountingDown = () => countingDown;
    const getDisplay = () => display;
    const getState = () => recorder?.state ?? 'inactive';

    function updateClock(force = false) {
      const seconds = Math.floor((elapsed + (started ? performance.now() - started : 0)) / 1000);
      const text = formatClock(seconds);
      if (force || text !== lastClockText) {
        lastClockText = text;
        el('clock').textContent = text;
      }
    }

    async function cleanupRecording() {
      clearInterval(drawTimer);
      drawTimer = null;
      stopCamera();
      releaseStream(canvasStream);
      releaseStream(microphone);
      canvasStream = null;
      microphone = null;
      if (audioContext) {
        await audioContext.close().catch(() => {});
        audioContext = null;
      }
    }

    function clearSource() {
      releaseStream(display);
      display = null;
      video.srcObject = null;
      onSourceCleared();
    }

    async function pickSource() {
      busy = true;
      onControlsChange();
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: Number(el('fps').value) },
          audio: el('system').checked
        });
        clearSource();
        display = stream;
        video.srcObject = stream;
        stream.getVideoTracks()[0].onended = () => {
          if (countingDown) {
            cancelCountdown();
            clearSource();
            onControlsChange();
            onStatus('畫面分享已結束');
          } else if (isActive()) {
            stopRecording();
          } else {
            clearSource();
            onControlsChange();
            onStatus('畫面分享已結束');
          }
        };
        await video.play();
        el('hint').hidden = true;
        const last = JSON.parse(localStorage.getItem('lastArea') || 'null');
        if (
          last &&
          last.width === video.videoWidth &&
          last.height === video.videoHeight &&
          last.label === stream.getVideoTracks()[0].label
        ) {
          setCrop(last.crop);
        }
        onStatus(
          '可在預覽中拖曳選取範圍。' +
            (stream.getAudioTracks().length ? ' 已取得分享音訊。' : ' 目前分享來源沒有音訊。')
        );
      } catch (e) {
        onStatus('無法選取畫面：' + e.message);
      } finally {
        busy = false;
        onControlsChange();
      }
    }

    function cancelCountdown() {
      if (countdownAbort) {
        countdownAbort.abort();
        countdownAbort = null;
      }
    }

    function waitSecond(signal) {
      return new Promise((resolve, reject) => {
        if (signal.aborted) {
          reject(new DOMException('Cancelled', 'AbortError'));
          return;
        }
        const id = setTimeout(() => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        }, 1000);
        function onAbort() {
          clearTimeout(id);
          reject(new DOMException('Cancelled', 'AbortError'));
        }
        signal.addEventListener('abort', onAbort, { once: true });
      });
    }

    async function startRecording() {
      if (!display || isActive() || busy) return;
      busy = true;
      onControlsChange();

      let file = null;
      let writes = Promise.resolve();
      let writeError = null;
      const filename = '錄影-' + new Date().toISOString().replace(/[:.]/g, '-') + '.mp4';

      try {
        const mimeType = [
          'video/mp4;codecs=avc1.640028,mp4a.40.2',
          'video/mp4;codecs=avc1.42E01F,mp4a.40.2',
          'video/mp4;codecs=avc1.42001E,mp4a.40.2',
          'video/mp4'
        ].find(t => MediaRecorder.isTypeSupported(t));
        if (!mimeType) throw new Error('目前的瀏覽器缺少 MP4 編碼器');

        await dbReady;
        file = createWriter(filename);

        const audioTracks = el('system').checked ? [...display.getAudioTracks()] : [];
        if (el('mic').checked) {
          const micId = el('micDevice').value;
          microphone = await navigator.mediaDevices.getUserMedia({
            audio: micId ? { deviceId: { exact: micId } } : true
          });
          audioTracks.push(...microphone.getAudioTracks());
        }

        if (!display || display.getVideoTracks()[0].readyState !== 'live' || video.readyState < 2) {
          throw new Error('請重新選擇畫面');
        }

        const [x, y, w, h] = getCrop() || [0, 0, 1, 1];
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(2, 2 * Math.floor((video.videoWidth * w) / 2));
        canvas.height = Math.max(2, 2 * Math.floor((video.videoHeight * h) / 2));
        const ctx = canvas.getContext('2d', { alpha: false });
        const fps = Number(el('fps').value);
        const videoBitsPerSecond = Number(el('quality').value) || 5000000;

        if (el('cam').checked) await startCamera();

        const delaySec = Number(el('delay').value);
        if (delaySec > 0) {
          countingDown = true;
          countdownAbort = new AbortController();
          onControlsChange();
          try {
            for (let count = delaySec; count > 0; count--) {
              onStatus(count + ' 秒後開始錄影（按停止或 Esc 可取消）');
              await waitSecond(countdownAbort.signal);
            }
          } finally {
            countingDown = false;
            countdownAbort = null;
          }
        }

        if (!display || display.getVideoTracks()[0].readyState !== 'live') {
          throw new Error('畫面分享已結束');
        }

        const draw = () => drawFrame(ctx, canvas, [x, y, w, h]);
        draw();
        canvasStream = canvas.captureStream(fps);

        if (audioTracks.length) {
          audioContext = new AudioContext();
          await audioContext.resume();
          const destination = audioContext.createMediaStreamDestination();
          audioTracks.forEach(track => {
            audioContext.createMediaStreamSource(new MediaStream([track])).connect(destination);
          });
          canvasStream.addTrack(destination.stream.getAudioTracks()[0]);
        }

        recorder = new MediaRecorder(canvasStream, { mimeType, videoBitsPerSecond });
        recorder.ondataavailable = ({ data }) => {
          if (!data.size) return;
          writes = writes
            .then(() => {
              if (!writeError) return file.write(data);
            })
            .catch(e => {
              writeError = e;
              stopRecording();
            });
        };
        recorder.onerror = e => {
          writeError = e.error || new Error('編碼失敗');
          stopRecording();
        };
        recorder.onstop = async () => {
          busy = true;
          onControlsChange();
          if (started) elapsed += performance.now() - started;
          started = 0;
          const durationSec = elapsed / 1000;
          updateClock(true);

          try {
            await writes;
            if (writeError) throw writeError;
            await file.close({ indexed: false, duration: durationSec });
            try {
              onStatus('正在建立時間軸並儲存影片…');
              const prepared = await indexedMp4(await readMedia(filename));
              const folderResult = await saveToFolder(filename, prepared);
              await saveBlobFile(filename, prepared, {
                indexed: true,
                duration: durationSec,
                savedToFolder: folderResult.ok
              });
              await onLibraryReady(filename, prepared);
              onStatus(folderResult.message);
            } catch (e) {
              await onLibraryReady(filename);
              onStatus('原始錄影已保留在媒體庫。輸出失敗：' + e.message);
            }
          } catch (e) {
            await onLibraryReady(filename);
            onStatus('儲存中斷，可在媒體庫查看已寫入的片段：' + e.message);
          } finally {
            await cleanupRecording();
            if (display && display.getVideoTracks()[0]?.readyState !== 'live') {
              clearSource();
            }
            recorder = null;
            busy = false;
            onControlsChange();
          }
        };

        recorder.start(1000);
        elapsed = 0;
        started = performance.now();
        updateClock(true);

        const limitMs = Number(el('limit').value) * 1000;
        drawTimer = setInterval(() => {
          if (recorder?.state === 'recording') {
            draw();
            if (limitMs && elapsed + performance.now() - started >= limitMs) {
              stopRecording();
            }
          }
          updateClock();
        }, 1000 / fps);

        el('download').hidden = true;
        onStatus('錄影中' + (audioTracks.length ? '，已加入音訊。' : '，未加入音訊。'));
        if (el('autoFloat').checked) {
          openFloatIfEnabled();
        }
      } catch (e) {
        await cleanupRecording();
        recorder = null;
        if (file) await file.abort().catch(() => {});
        onStatus(e.name === 'AbortError' ? '已取消錄影。' : '無法開始錄影：' + e.message);
      } finally {
        busy = false;
        onControlsChange();
      }
    }

    function togglePause() {
      if (!recorder || !isActive()) return;
      if (recorder.state === 'recording') {
        recorder.pause();
        elapsed += performance.now() - started;
        started = 0;
        onStatus('已暫停');
      } else {
        recorder.resume();
        started = performance.now();
        onStatus('錄影中');
      }
      updateClock(true);
      onControlsChange();
    }

    function stopRecording() {
      if (countingDown) {
        cancelCountdown();
        return;
      }
      if (isActive()) {
        busy = true;
        recorder.stop();
        onControlsChange();
      }
    }

    return {
      pickSource,
      startRecording,
      togglePause,
      stopRecording,
      clearSource,
      isActive,
      isBusy,
      isCountingDown,
      getDisplay,
      getState
    };
  }

  Studio.recorder = { formatClock, releaseStream, createRecorderController };
})();
