using System.Drawing.Imaging;
using System.Runtime.InteropServices;

sealed class DesktopRecording : IDisposable
{
    [DllImport("DesktopEncoder.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    static extern int OpenEncoder(string path, int width, int height, int audioMode, out nint encoder);
    [DllImport("DesktopEncoder.dll")] static extern int WriteFrame(nint encoder, nint pixels, int stride, long time, long duration);
    [DllImport("DesktopEncoder.dll")] static extern int CloseEncoder(nint encoder, long end);
    [DllImport("DesktopEncoder.dll")] static extern int SetAudioPaused(nint encoder, int paused);
    public void PauseAudio(bool pause) => Marshal.ThrowExceptionForHR(SetAudioPaused(encoder, pause ? 1 : 0));

    readonly Rectangle area;
    readonly Bitmap frame;
    readonly string temporary;
    readonly string destination;
    long previous;
    nint encoder;
    bool finished;

    public DesktopRecording(Rectangle area, string destination, int audioMode)
    {
        this.area = area;
        this.destination = destination;
        temporary = Path.Combine(Path.GetDirectoryName(destination)!, "." + Guid.NewGuid() + ".partial.mp4");
        var scale = Math.Min(1d, Math.Min(1920d / area.Width, 1080d / area.Height));
        frame = new Bitmap(Math.Max(2, (int)(area.Width * scale) / 2 * 2),
            Math.Max(2, (int)(area.Height * scale) / 2 * 2), PixelFormat.Format32bppRgb);
        try
        {
            Capture();
            Marshal.ThrowExceptionForHR(OpenEncoder(temporary, frame.Width, frame.Height, audioMode, out encoder));
        }
        catch
        {
            frame.Dispose();
            if (File.Exists(temporary)) File.Delete(temporary);
            throw;
        }
    }

    [DllImport("user32.dll")] static extern nint GetDC(nint window);
    [DllImport("user32.dll")] static extern int ReleaseDC(nint window, nint dc);
    [DllImport("gdi32.dll")] static extern int SetStretchBltMode(nint dc, int mode);
    [DllImport("gdi32.dll", SetLastError = true)]
    static extern bool StretchBlt(nint dest, int x, int y, int w, int h, nint source,
        int sx, int sy, int sw, int sh, uint mode);

    void Capture()
    {
        using var graphics = Graphics.FromImage(frame);
        var screen = GetDC(0);
        var target = graphics.GetHdc();
        try
        {
            SetStretchBltMode(target, 4);
            if (!StretchBlt(target, 0, 0, frame.Width, frame.Height, screen, area.X, area.Y,
                    area.Width, area.Height, 0x40CC0020))
                throw new System.ComponentModel.Win32Exception();
        }
        finally { graphics.ReleaseHdc(target); ReleaseDC(0, screen); }
    }

    void WriteUntil(long time)
    {
        if (time <= previous) return;
        var data = frame.LockBits(new Rectangle(Point.Empty, frame.Size), ImageLockMode.ReadOnly, frame.PixelFormat);
        try { Marshal.ThrowExceptionForHR(WriteFrame(encoder, data.Scan0, data.Stride, previous, time - previous)); }
        finally { frame.UnlockBits(data); }
        previous = time;
    }
    public void Tick(long time) { WriteUntil(time); Capture(); }
    public void Finish(long time)
    {
        WriteUntil(Math.Max(time, previous + 1));
        var handle = encoder;
        encoder = 0;
        Marshal.ThrowExceptionForHR(CloseEncoder(handle, previous));
        File.Move(temporary, destination);
        finished = true;
    }
    public void Dispose()
    {
        if (encoder != 0) { CloseEncoder(encoder, previous); encoder = 0; }
        frame.Dispose();
        if (!finished)
        {
            try { if (File.Exists(temporary)) File.Delete(temporary); }
            catch { }
        }
    }
}
