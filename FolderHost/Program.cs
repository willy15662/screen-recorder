using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http.Features;

if (args.Length == 0 || (args.Length == 1 && args[0] == "--widget") || (args.Length == 2 && args[1] == "--widget"))
{
    var installRoot = args.Length == 2 ? Path.GetFullPath(args[0]) : AppContext.BaseDirectory;
    var ui = new Thread(() =>
    {
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        using var instance = new Mutex(true, @"Local\DesktopStudioWidget", out var first);
        if (!first) { DesktopWidget.ActivateExisting(); return; }
        Application.Run(new DesktopWidget(installRoot));
    });
    ui.SetApartmentState(ApartmentState.STA);
    ui.Start();
    ui.Join();
    return 0;
}

if (args.Length < 2)
    return 1;

var root = Path.GetFullPath(args[0]);
var browserPath = Path.GetFullPath(args[1]);
var allowTestLauncher = Environment.GetEnvironmentVariable("SCREEN_RECORDER_ALLOW_TEST_LAUNCHER") == "1";
if (!allowTestLauncher && !string.Equals(Path.GetFileName(browserPath), "msedge.exe", StringComparison.OrdinalIgnoreCase))
    return 1;

var profile = Environment.GetEnvironmentVariable("SCREEN_RECORDER_PROFILE")
    ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LocalScreenRecorder");
Directory.CreateDirectory(profile);

var defaultDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyVideos), "桌面錄影室");
var preference = Path.Combine(profile, "output-folder.txt");
var directory = LoadSavedDirectory(preference, defaultDirectory);

var profileId = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(Path.GetFullPath(profile).ToUpperInvariant())));
using var reopen = new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\DesktopStudioOpen-" + profileId, out var firstHost);
if (!firstHost) { reopen.Set(); return 0; }
var launchGate = new object();
var launchToken = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
var sessionKey = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
var launchConsumed = 0;

var preferredPort = int.TryParse(Environment.GetEnvironmentVariable("SCREEN_RECORDER_PORT"), out var parsedPort)
    ? parsedPort
    : 48721;

var staticFiles = new Dictionary<string, (string RelativePath, string ContentType)>(StringComparer.Ordinal)
{
    ["/"] = ("index.html", "text/html; charset=utf-8"),
    ["/index.html"] = ("index.html", "text/html; charset=utf-8"),
    ["/studio.css"] = ("studio.css", "text/css; charset=utf-8"),
    ["/mp4.js"] = ("mp4.js", "text/javascript; charset=utf-8"),
    ["/storage.js"] = ("storage.js", "text/javascript; charset=utf-8"),
    ["/folders.js"] = ("folders.js", "text/javascript; charset=utf-8"),
    ["/recorder.js"] = ("recorder.js", "text/javascript; charset=utf-8"),
    ["/studio.js"] = ("studio.js", "text/javascript; charset=utf-8"),
    ["/vendor/mediabunny-1.29.1.js"] = (Path.Combine("vendor", "mediabunny-1.29.1.js"), "text/javascript; charset=utf-8"),
};

var filenameRegex = new Regex(@"\A(?:錄影-[0-9TZ._-]+\.mp4|截圖-[0-9TZ._-]+\.png)\z", RegexOptions.Compiled);
var chooseGate = new SemaphoreSlim(1, 1);
var saveGate = new SemaphoreSlim(2, 2);
var allowDevDiskAssets = Environment.GetEnvironmentVariable("SCREEN_RECORDER_DEV_DISK_ASSETS") == "1";
using var shutdownCts = new CancellationTokenSource();
long lastRequest = Environment.TickCount64;
int requests = 0;
string expectedOrigin = "";

WebApplication BuildApp(int port)
{
    var builder = WebApplication.CreateBuilder();
    builder.Logging.ClearProviders();
    builder.WebHost.ConfigureKestrel(options => options.Listen(IPAddress.Loopback, port));
    var webApp = builder.Build();

    webApp.Use(async (ctx, next) =>
    {
        ctx.Response.Headers.CacheControl = "no-store";
        ctx.Response.Headers["X-Content-Type-Options"] = "nosniff";
        ctx.Response.Headers["Content-Security-Policy"] =
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'";

        Interlocked.Increment(ref requests);
        try
        {
            await next();
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or Win32Exception)
        {
            if (!ctx.Response.HasStarted)
            {
                ctx.Response.StatusCode = 409;
                await ctx.Response.WriteAsync(FriendlyError(e));
            }
        }
        finally
        {
            Interlocked.Exchange(ref lastRequest, Environment.TickCount64);
            Interlocked.Decrement(ref requests);
        }
    });

    webApp.MapGet("/launch", (HttpContext ctx) =>
    {
        var token = ctx.Request.Query["t"].ToString();
        lock (launchGate)
        {
            if (!FixedTimeEquals(token, launchToken) || launchConsumed != 0) return Results.StatusCode(403);
            launchConsumed = 1;
        }

        ctx.Response.Cookies.Append("studio_session", sessionKey, new CookieOptions
        {
            HttpOnly = true,
            SameSite = SameSiteMode.Strict,
            Path = "/",
            IsEssential = true
        });
        return Results.Redirect("/");
    });

    var assembly = Assembly.GetExecutingAssembly();
    foreach (var (route, entry) in staticFiles)
    {
        var fullPath = Path.Combine(root, entry.RelativePath);
        var resourceName = "web/" + entry.RelativePath.Replace('\\', '/');
        var contentType = entry.ContentType;
        webApp.MapGet(route, () =>
        {
            if (allowDevDiskAssets && File.Exists(fullPath))
                return Results.File(fullPath, contentType);
            var stream = assembly.GetManifestResourceStream(resourceName);
            return stream != null
                ? Results.Stream(stream, contentType)
                : Results.NotFound();
        });
    }

    bool IsAuthorizedApi(HttpContext ctx, bool requireCustomHeader)
    {
        if (!string.Equals(ctx.Request.Headers.Origin.ToString(), expectedOrigin, StringComparison.Ordinal))
            return false;
        if (!FixedTimeEquals(ctx.Request.Cookies["studio_session"], sessionKey))
            return false;
        if (requireCustomHeader && !string.Equals(ctx.Request.Headers["X-Studio-Client"].ToString(), "1", StringComparison.Ordinal))
            return false;
        return true;
    }

    webApp.MapPost("/api/folder", (HttpContext ctx) =>
    {
        if (!IsAuthorizedApi(ctx, true)) return Results.StatusCode(403);
        return Results.Text(Volatile.Read(ref directory));
    });

    webApp.MapPost("/api/choose", async (HttpContext ctx) =>
    {
        if (!IsAuthorizedApi(ctx, true)) return Results.StatusCode(403);
        if (!await chooseGate.WaitAsync(0))
            return Results.Conflict("資料夾選擇視窗已開啟");

        try
        {
            var currentDir = Volatile.Read(ref directory);
            var result = new TaskCompletionSource<string?>(TaskCreationOptions.RunContinuationsAsynchronously);
            var thread = new Thread(() =>
            {
                try
                {
                    using var owner = new Form
                    {
                        TopMost = true,
                        ShowInTaskbar = false,
                        FormBorderStyle = FormBorderStyle.None,
                        StartPosition = FormStartPosition.CenterScreen,
                        Size = new Size(1, 1),
                        Opacity = 0.01
                    };
                    using var dialog = new FolderBrowserDialog
                    {
                        InitialDirectory = Directory.Exists(currentDir) ? currentDir : defaultDirectory,
                        Description = "選擇錄影與截圖的存放位置",
                        UseDescriptionForTitle = true
                    };
                    owner.Show();
                    ForceForeground(owner.Handle);
                    owner.Activate();
                    result.SetResult(dialog.ShowDialog(owner) == DialogResult.OK ? dialog.SelectedPath : null);
                }
                catch (Exception e)
                {
                    result.SetException(e);
                }
            });
            thread.SetApartmentState(ApartmentState.STA);
            thread.Start();

            if (await result.Task is string selected && IsValidLocalDirectory(selected))
            {
                var temp = preference + "." + Guid.NewGuid() + ".tmp";
                try
                {
                    await File.WriteAllTextAsync(temp, selected);
                    File.Move(temp, preference, true);
                    Volatile.Write(ref directory, selected);
                }
                finally
                {
                    TryDeleteFile(temp);
                }
            }
            return Results.Text(Volatile.Read(ref directory));
        }
        finally
        {
            chooseGate.Release();
        }
    });

    webApp.MapPost("/api/open", (HttpContext ctx) =>
    {
        if (!IsAuthorizedApi(ctx, true)) return Results.StatusCode(403);
        var currentDir = Volatile.Read(ref directory);
        if (!IsValidLocalDirectory(currentDir))
            return Results.Conflict("儲存資料夾路徑無效");

        var path = Directory.CreateDirectory(currentDir).FullName;
        var explorerPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "explorer.exe");
        var start = new ProcessStartInfo(explorerPath);
        start.ArgumentList.Add(path);
        Process.Start(start);
        return Results.NoContent();
    });

    webApp.MapPost("/api/save", async (HttpContext ctx) =>
    {
        if (!IsAuthorizedApi(ctx, true)) return Results.StatusCode(403);

        var name = ctx.Request.Query["name"].ToString();
        if (!filenameRegex.IsMatch(name) || name.Contains("..", StringComparison.Ordinal))
            return Results.BadRequest("檔名格式無效");

        if (!await saveGate.WaitAsync(0))
            return Results.StatusCode(429);

        try
        {
            const long maxUploadBytes = 4L * 1024 * 1024 * 1024;
            const long minFreeBytes = 16L * 1024 * 1024;
            var sizeFeature = ctx.Features.Get<IHttpMaxRequestBodySizeFeature>();
            if (sizeFeature != null) sizeFeature.MaxRequestBodySize = maxUploadBytes;

            var currentDir = Volatile.Read(ref directory);
            if (!LocalPathGuard.IsValidLocalDirectory(currentDir))
                return Results.Conflict("儲存資料夾路徑無效");

            var target = Directory.CreateDirectory(currentDir).FullName;
            var pathRoot = Path.GetPathRoot(target);
            DriveInfo? drive = !string.IsNullOrEmpty(pathRoot) ? new DriveInfo(pathRoot) : null;
            if (drive != null)
            {
                var required = (ctx.Request.ContentLength ?? 0) + minFreeBytes;
                if (drive.IsReady && drive.AvailableFreeSpace < required)
                    return Results.Conflict("目標磁碟可用空間不足");
            }

            var temporary = Path.Combine(target, "." + Guid.NewGuid() + ".partial");
            try
            {
                var header = new byte[12];
                var headerFilled = 0;
                var headerChecked = false;
                long written = 0;
                long nextSpaceCheck = minFreeBytes;
                var buffer = new byte[131072];

                await using (var output = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 131072, true))
                {
                    int read;
                    while ((read = await ctx.Request.Body.ReadAsync(buffer, ctx.RequestAborted)) > 0)
                    {
                        written += read;
                        if (written > maxUploadBytes)
                            return Results.StatusCode(413);

                        if (headerFilled < header.Length)
                        {
                            var copyCount = Math.Min(header.Length - headerFilled, read);
                            Buffer.BlockCopy(buffer, 0, header, headerFilled, copyCount);
                            headerFilled += copyCount;
                        }
                        if (!headerChecked && headerFilled >= 8)
                        {
                            if (!HasValidMagicBytes(name, header, headerFilled))
                                return Results.BadRequest("檔案內容格式無效");
                            headerChecked = true;
                        }
                        if (drive != null && written >= nextSpaceCheck)
                        {
                            if (drive.IsReady && drive.AvailableFreeSpace < minFreeBytes)
                                return Results.Conflict("目標磁碟可用空間不足");
                            nextSpaceCheck = written + minFreeBytes;
                        }
                        await output.WriteAsync(buffer.AsMemory(0, read), ctx.RequestAborted);
                    }
                }

                if (!headerChecked || !HasValidMagicBytes(name, header, headerFilled))
                    return Results.BadRequest("檔案內容格式無效");

                File.Move(temporary, Path.Combine(target, name));
                return Results.Text(target);
            }
            finally
            {
                TryDeleteFile(temporary);
            }
        }
        finally
        {
            saveGate.Release();
        }
    });

    webApp.MapPost("/api/shutdown", (HttpContext ctx) =>
    {
        if (!IsAuthorizedApi(ctx, false)) return Results.StatusCode(403);
        shutdownCts.Cancel();
        return Results.NoContent();
    });

    return webApp;
}

WebApplication app = BuildApp(preferredPort);
try
{
    await app.StartAsync();
}
catch (IOException) when (preferredPort != 0)
{
    await app.DisposeAsync();
    app = BuildApp(0);
    await app.StartAsync();
}

var boundUrl = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
var boundPort = new Uri(boundUrl).Port;
expectedOrigin = $"http://127.0.0.1:{boundPort}";

void OpenStudioWindow()
{
    lock (launchGate)
    {
        launchToken = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        launchConsumed = 0;
    }
    var launchUrl = $"{expectedOrigin}/launch?t={launchToken}";
    var startEdge = new ProcessStartInfo(browserPath);
    foreach (var arg in new[]
    {
        "--user-data-dir=" + Path.Combine(profile, "Profile"),
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
        "--app=" + launchUrl
    })
    {
        startEdge.ArgumentList.Add(arg);
    }
    Process.Start(startEdge);
}
OpenStudioWindow();

try
{
    while (!shutdownCts.IsCancellationRequested &&
           (Volatile.Read(ref requests) > 0 || Environment.TickCount64 - Interlocked.Read(ref lastRequest) < 600_000))
    {
        if (WaitHandle.WaitAny([reopen, shutdownCts.Token.WaitHandle], 5000) == 0)
        {
            Interlocked.Exchange(ref lastRequest, Environment.TickCount64);
            OpenStudioWindow();
        }
    }
}
catch (OperationCanceledException)
{
}

await app.StopAsync();
await app.DisposeAsync();
return 0;

static bool FixedTimeEquals(string? actual, string expected)
{
    if (string.IsNullOrEmpty(actual)) return false;
    var a = Encoding.UTF8.GetBytes(actual);
    var b = Encoding.UTF8.GetBytes(expected);
    return a.Length == b.Length && CryptographicOperations.FixedTimeEquals(a, b);
}

static bool IsValidLocalDirectory(string? path) => LocalPathGuard.IsValidLocalDirectory(path);

static string LoadSavedDirectory(string preferencePath, string fallback)
{
    if (!File.Exists(preferencePath)) return fallback;
    var raw = File.ReadAllText(preferencePath).Trim();
    return IsValidLocalDirectory(raw) ? raw : fallback;
}

static bool HasValidMagicBytes(string filename, byte[] header, int length)
{
    if (filename.EndsWith(".png", StringComparison.Ordinal))
    {
        ReadOnlySpan<byte> pngSig = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        return length >= pngSig.Length && header.AsSpan(0, pngSig.Length).SequenceEqual(pngSig);
    }
    if (filename.EndsWith(".mp4", StringComparison.Ordinal))
    {
        ReadOnlySpan<byte> ftyp = "ftyp"u8;
        return length >= 8 && header.AsSpan(4, 4).SequenceEqual(ftyp);
    }
    return false;
}

static void TryDeleteFile(string path)
{
    try
    {
        if (File.Exists(path)) File.Delete(path);
    }
    catch
    {
    }
}

static string FriendlyError(Exception e) => e switch
{
    UnauthorizedAccessException => "沒有寫入目標資料夾的權限",
    IOException => "檔案已存在或無法寫入目標資料夾",
    _ => "資料夾操作失敗"
};

static void ForceForeground(nint hwnd)
{
    var fg = Win32.GetForegroundWindow();
    var fgThread = fg != 0 ? Win32.GetWindowThreadProcessId(fg, out _) : 0;
    var curThread = Win32.GetCurrentThreadId();
    var attached = fgThread != 0 && fgThread != curThread && Win32.AttachThreadInput(curThread, fgThread, true);
    try
    {
        Win32.BringWindowToTop(hwnd);
        Win32.SetForegroundWindow(hwnd);
    }
    finally
    {
        if (attached) Win32.AttachThreadInput(curThread, fgThread, false);
    }
}

static class LocalPathGuard
{
    public static bool IsValidLocalDirectory(string? path)
    {
        if (string.IsNullOrWhiteSpace(path)) return false;
        var trimmed = path.Trim();
        if (trimmed.StartsWith(@"\\", StringComparison.Ordinal) || trimmed.StartsWith("//", StringComparison.Ordinal))
            return false;
        if (trimmed.IndexOfAny(Path.GetInvalidPathChars()) >= 0)
            return false;
        if (!Path.IsPathFullyQualified(trimmed))
            return false;
        try
        {
            var full = Path.GetFullPath(trimmed);
            var root = Path.GetPathRoot(full);
            if (string.IsNullOrEmpty(root)) return false;
            var drive = new DriveInfo(root);
            if (drive.DriveType is not (DriveType.Fixed or DriveType.Removable))
                return false;
            var current = full.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            while (!string.IsNullOrEmpty(current) && !string.Equals(current + Path.DirectorySeparatorChar, root, StringComparison.OrdinalIgnoreCase))
            {
                if (Directory.Exists(current) && (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                    return false;
                current = Path.GetDirectoryName(current);
            }
            return true;
        }
        catch
        {
            return false;
        }
    }
}

static class Win32
{
    [DllImport("user32.dll")]
    public static extern nint GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(nint hWnd, out uint lpdwProcessId);

    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("user32.dll")]
    public static extern bool BringWindowToTop(nint hWnd);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(nint hWnd);
}
