(() => {
  'use strict';
  const Studio = (globalThis.Studio = globalThis.Studio || {});

  function createFlatChunkWriter() {
    const chunks = [];
    let totalSize = 0;

    return {
      write(position, data) {
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        if (position > totalSize) {
          throw new Error('MP4 寫入位置超出範圍');
        }
        if (position === totalSize) {
          if (bytes.byteLength > 0) {
            chunks.push(bytes.slice());
            totalSize += bytes.byteLength;
          }
          return;
        }

        let offset = 0;
        let srcPos = 0;
        let writePos = position;

        for (let i = 0; i < chunks.length && srcPos < bytes.byteLength; i++) {
          const chunk = chunks[i];
          const chunkEnd = offset + chunk.byteLength;
          if (writePos < chunkEnd) {
            const localStart = writePos - offset;
            const copyLen = Math.min(chunk.byteLength - localStart, bytes.byteLength - srcPos);
            chunk.set(bytes.subarray(srcPos, srcPos + copyLen), localStart);
            srcPos += copyLen;
            writePos += copyLen;
          }
          offset = chunkEnd;
        }

        if (srcPos < bytes.byteLength) {
          const tail = bytes.slice(srcPos);
          chunks.push(tail);
          totalSize += tail.byteLength;
        }
      },
      get size() {
        return totalSize;
      },
      toBlob() {
        return new Blob(chunks, { type: 'video/mp4' });
      }
    };
  }

  function createTarget(writer) {
    const M = globalThis.Mediabunny;
    return new M.StreamTarget(
      new WritableStream({
        write({ position, data }) {
          writer.write(position, data);
        }
      }),
      { chunked: true, chunkSize: 4 * 1024 * 1024 }
    );
  }

  async function indexedMp4(blob) {
    const M = globalThis.Mediabunny;
    const input = new M.Input({ source: new M.BlobSource(blob), formats: [M.MP4] });
    const writer = createFlatChunkWriter();
    const target = createTarget(writer);
    try {
      const output = new M.Output({ format: new M.Mp4OutputFormat({ fastStart: false }), target });
      const tracks = (await input.getTracks()).map(track => {
        const source = track.isVideoTrack()
          ? new M.EncodedVideoPacketSource(track.codec)
          : new M.EncodedAudioPacketSource(track.codec);
        if (track.isVideoTrack()) output.addVideoTrack(source);
        else output.addAudioTrack(source);
        return { track, source };
      });
      await output.start();
      await Promise.all(
        tracks.map(async ({ track, source }) => {
          let metadata = { decoderConfig: await track.getDecoderConfig() };
          for await (const packet of new M.EncodedPacketSink(track).packets()) {
            await source.add(packet, metadata);
            metadata = undefined;
          }
          source.close();
        })
      );
      await output.finalize();
      return writer.toBlob();
    } finally {
      input.dispose();
    }
  }

  async function trimMp4(blob, startSec, endSec) {
    const M = globalThis.Mediabunny;
    const input = new M.Input({ source: new M.BlobSource(blob), formats: [M.MP4] });
    const writer = createFlatChunkWriter();
    const target = createTarget(writer);
    try {
      const output = new M.Output({ format: new M.Mp4OutputFormat({ fastStart: false }), target });
      const conversion = await M.Conversion.init({
        input,
        output,
        trim: { start: startSec, end: endSec }
      });
      await conversion.execute();
      return writer.toBlob();
    } finally {
      input.dispose();
    }
  }

  Studio.mp4 = { createFlatChunkWriter, indexedMp4, trimMp4 };
})();
