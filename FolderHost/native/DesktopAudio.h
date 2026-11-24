// Shared-mode WASAPI capture on the default Windows output or microphone.
#include <audioclient.h>
#include <mmdeviceapi.h>
#include <vector>

class DesktopAudio {
    ComPtr<IAudioClient> client;
    ComPtr<IAudioCaptureClient> capture;
    DWORD stream = 0;
    LONGLONG nextFrame = 0;
    static constexpr DWORD rate = 48000, bytesPerFrame = 4;
    static LONGLONG ticks(LONGLONG frames) { return frames * 10000000 / rate; }

    HRESULT append(IMFSinkWriter* writer, const BYTE* data, DWORD frames) {
        if (!frames) return S_OK;
        if (frames > UINT32_MAX / bytesPerFrame) return E_INVALIDARG;
        ComPtr<IMFMediaBuffer> buffer;
        DWORD size = frames * bytesPerFrame;
        CHECK(MFCreateMemoryBuffer(size, &buffer));
        BYTE* dst;
        CHECK(buffer->Lock(&dst,nullptr,nullptr));
        if (data) memcpy(dst,data,size); else memset(dst,0,size);
        CHECK(buffer->Unlock());
        CHECK(buffer->SetCurrentLength(size));
        ComPtr<IMFSample> sample;
        CHECK(MFCreateSample(&sample));
        CHECK(sample->AddBuffer(buffer.Get()));
        CHECK(sample->SetSampleTime(ticks(nextFrame)));
        CHECK(sample->SetSampleDuration(ticks(nextFrame + frames) - ticks(nextFrame)));
        CHECK(writer->WriteSample(stream,sample.Get()));
        nextFrame += frames;
        return S_OK;
    }
    HRESULT silenceUntil(IMFSinkWriter* writer, LONGLONG frame) {
        while (nextFrame < frame) {
            DWORD count = static_cast<DWORD>((std::min)(frame-nextFrame,static_cast<LONGLONG>(rate/10)));
            CHECK(append(writer,nullptr,count));
        }
        return S_OK;
    }
public:
    HRESULT configure(IMFSinkWriter* writer, bool loopback) {
        ComPtr<IMMDeviceEnumerator> devices;
        ComPtr<IMMDevice> endpoint;
        CHECK(CoCreateInstance(__uuidof(MMDeviceEnumerator),nullptr,CLSCTX_ALL,IID_PPV_ARGS(&devices)));
        CHECK(devices->GetDefaultAudioEndpoint(loopback ? eRender : eCapture,eConsole,&endpoint));
        CHECK(endpoint->Activate(__uuidof(IAudioClient),CLSCTX_ALL,nullptr,&client));
        WAVEFORMATEX fmt = { WAVE_FORMAT_PCM, 2, rate, rate*bytesPerFrame, bytesPerFrame, 16, 0 };
        DWORD flags = AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
        if (loopback) flags |= AUDCLNT_STREAMFLAGS_LOOPBACK;
        CHECK(client->Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 10000000, 0, &fmt,nullptr));
        CHECK(client->GetService(IID_PPV_ARGS(&capture)));
        ComPtr<IMFMediaType> target, source;
        CHECK(MFCreateMediaType(&target));
        CHECK(target->SetGUID(MF_MT_MAJOR_TYPE,MFMediaType_Audio));
        CHECK(target->SetGUID(MF_MT_SUBTYPE,MFAudioFormat_AAC));
        CHECK(target->SetUINT32(MF_MT_AUDIO_NUM_CHANNELS,2));
        CHECK(target->SetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND,rate));
        CHECK(target->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE,16));
        CHECK(target->SetUINT32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND,16000));
        CHECK(writer->AddStream(target.Get(), &stream));
        CHECK(MFCreateMediaType(&source));
        CHECK(MFInitMediaTypeFromWaveFormatEx(source.Get(),&fmt,sizeof(fmt)));
        return writer->SetInputMediaType(stream,source.Get(),nullptr);
    }
    HRESULT start() { return client->Start(); }
    HRESULT pause() { CHECK(client->Stop()); return client->Reset(); }

    HRESULT drain(IMFSinkWriter* writer, LONGLONG end, bool finish) {
        LARGE_INTEGER now, freq;
        QueryPerformanceCounter(&now); QueryPerformanceFrequency(&freq);
        const LONGLONG wall = static_cast<LONGLONG>(static_cast<double>(now.QuadPart) * 10000000 / freq.QuadPart);
        const LONGLONG limit = end * rate / 10000000;
        UINT32 pending = 0;
        CHECK(capture->GetNextPacketSize(&pending));
        while (pending) {
            BYTE* data; UINT32 frames; DWORD flags; UINT64 position, stamp;
            CHECK(capture->GetBuffer(&data,&frames,&flags,&position,&stamp));
            const LONGLONG start = (flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR) ? nextFrame :
                (end + static_cast<LONGLONG>(stamp) - wall) * rate / 10000000;
            HRESULT hr = silenceUntil(writer,(std::min)(limit,start));
            const LONGLONG skip = (std::clamp)(nextFrame - start,0LL,static_cast<LONGLONG>(frames));
            const DWORD count = static_cast<DWORD>((std::min)(static_cast<LONGLONG>(frames)-skip, (std::max)(0LL,limit-nextFrame)));
            if (SUCCEEDED(hr)) hr = append(writer,(flags & AUDCLNT_BUFFERFLAGS_SILENT) ? nullptr : data + skip*bytesPerFrame,count);
            CHECK(capture->ReleaseBuffer(frames));
            if (FAILED(hr)) return hr;
            CHECK(capture->GetNextPacketSize(&pending));
        }
        return silenceUntil(writer,finish ? limit : limit-rate/10);
    }
};
