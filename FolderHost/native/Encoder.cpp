// Windows Media Foundation MP4 writer. Each instance belongs to the calling UI thread.
#include <windows.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <wrl/client.h>
#include <memory>
#include <algorithm>
#include <cstdint>
using Microsoft::WRL::ComPtr;
#define CHECK(call) do { HRESULT hr = (call); if (FAILED(hr)) return hr; } while (0)

#include "DesktopAudio.h"

struct Encoder {
    std::unique_ptr<DesktopAudio> audio;
    ComPtr<IMFSinkWriter> writer;
    DWORD stream = 0;
    UINT32 width, height;
    bool initialized = false;
    ~Encoder() { audio.reset(); writer.Reset(); if (initialized) MFShutdown(); }
};

static HRESULT videoType(GUID format, UINT32 w, UINT32 h, IMFMediaType** result) {
    ComPtr<IMFMediaType> type;
    CHECK(MFCreateMediaType(&type));
    CHECK(type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video));
    CHECK(type->SetGUID(MF_MT_SUBTYPE, format));
    CHECK(type->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive));
    CHECK(MFSetAttributeSize(type.Get(), MF_MT_FRAME_SIZE, w, h));
    CHECK(MFSetAttributeRatio(type.Get(), MF_MT_FRAME_RATE, 25, 1));
    CHECK(MFSetAttributeRatio(type.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1));
    return type.CopyTo(result);
}

extern "C" __declspec(dllexport) HRESULT OpenEncoder(const wchar_t* path, UINT32 w, UINT32 h, int audioMode, Encoder** result) {
    if (!path || !result || w < 2 || h < 2 || w > 7680 || h > 4320 || (w & 1) || (h & 1))
        return E_INVALIDARG;
    *result = nullptr;
    auto enc = std::make_unique<Encoder>();
    CHECK(MFStartup(MF_VERSION));
    enc->initialized = true;
    enc->width = w; enc->height = h;
    CHECK(MFCreateSinkWriterFromURL(path, nullptr, nullptr, &enc->writer));
    ComPtr<IMFMediaType> output, input;
    CHECK(videoType(MFVideoFormat_H264, w, h, &output));
    CHECK(output->SetUINT32(MF_MT_AVG_BITRATE, 6000000));
    CHECK(enc->writer->AddStream(output.Get(), &enc->stream));
    CHECK(videoType(MFVideoFormat_RGB32, w, h, &input));
    CHECK(input->SetUINT32(MF_MT_DEFAULT_STRIDE, static_cast<UINT32>(-static_cast<LONG>(w * 4))));
    CHECK(enc->writer->SetInputMediaType(enc->stream, input.Get(), nullptr));
    if (audioMode) {
        enc->audio = std::make_unique<DesktopAudio>();
        CHECK(enc->audio->configure(enc->writer.Get(), audioMode == 1));
    }
    CHECK(enc->writer->BeginWriting());
    if (enc->audio) CHECK(enc->audio->start());
    *result = enc.release();
    return S_OK;
}

extern "C" __declspec(dllexport) HRESULT WriteFrame(Encoder* enc, BYTE* top, LONG stride, LONGLONG time, LONGLONG duration) {
    if (!enc || !top || stride <= 0) return E_INVALIDARG;
    const uint64_t row64 = static_cast<uint64_t>(enc->width) * 4;
    const uint64_t size64 = row64 * static_cast<uint64_t>(enc->height);
    if (row64 == 0 || static_cast<uint64_t>(stride) < row64 || size64 > UINT32_MAX) return E_INVALIDARG;
    const DWORD row = static_cast<DWORD>(row64), size = static_cast<DWORD>(size64);
    ComPtr<IMFMediaBuffer> buffer;
    CHECK(MFCreateMemoryBuffer(size, &buffer));
    BYTE* dst = nullptr;
    CHECK(buffer->Lock(&dst, nullptr, nullptr));
    for (UINT32 y = 0; y < enc->height; ++y)
        memcpy(dst + (enc->height - 1 - y) * row, top + static_cast<ptrdiff_t>(y) * stride, row);
    CHECK(buffer->Unlock());
    CHECK(buffer->SetCurrentLength(size));
    ComPtr<IMFSample> sample;
    CHECK(MFCreateSample(&sample));
    CHECK(sample->AddBuffer(buffer.Get()));
    CHECK(sample->SetSampleTime(time));
    CHECK(sample->SetSampleDuration(duration));
    CHECK(enc->writer->WriteSample(enc->stream, sample.Get()));
    return enc->audio ? enc->audio->drain(enc->writer.Get(), time + duration, false) : S_OK;
}

extern "C" __declspec(dllexport) HRESULT SetAudioPaused(Encoder* enc, int paused) {
    if (!enc) return E_INVALIDARG;
    return !enc->audio ? S_OK : paused ? enc->audio->pause() : enc->audio->start();
}

extern "C" __declspec(dllexport) HRESULT CloseEncoder(Encoder* encoder, LONGLONG end) {
    if (!encoder) return E_INVALIDARG;
    std::unique_ptr<Encoder> enc(encoder);
    auto audioResult = enc->audio ? enc->audio->drain(enc->writer.Get(), end, true) : S_OK;
    auto finalized = enc->writer->Finalize();
    return FAILED(finalized) ? finalized : audioResult;
}
