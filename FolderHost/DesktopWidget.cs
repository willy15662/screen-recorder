using System.Diagnostics;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

sealed class DesktopWidget : Form
{
    const string Title = "桌面錄影小工具";
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern nint FindWindow(string? cls, string name);
    [DllImport("user32.dll")] static extern bool ShowWindow(nint hwnd, int command);
    [DllImport("user32.dll")] static extern bool RegisterHotKey(nint hwnd, int id, uint modifiers, uint key);
    [DllImport("user32.dll")] static extern bool UnregisterHotKey(nint hwnd, int id);
    [DllImport("user32.dll")] static extern bool SetWindowDisplayAffinity(nint hwnd, uint affinity);
    public static void ActivateExisting()
    {
        var hwnd = FindWindow(null, Title);
        if (hwnd == 0) hwnd = FindWindow(null, Title + " · F9 停止");
        if (hwnd != 0) { ShowWindow(hwnd, 9); Win32.SetForegroundWindow(hwnd); }
    }

    readonly string root;
    readonly string preference;
    readonly Label status = new() { AutoEllipsis = true, TextAlign = ContentAlignment.MiddleLeft, Dock = DockStyle.Fill };
    readonly Button record, pause, select;
    readonly ToolStripMenuItem reset, advanced, choose, audio;
    int audioMode;
    static readonly string[] AudioNames = ["無聲", "系統聲音", "麥克風"];
    readonly System.Windows.Forms.Timer timer = new() { Interval = 40 };
    readonly Stopwatch clock = new();
    readonly ContextMenuStrip menu = new();
    Rectangle area;
    DesktopRecording? recording;
    bool hasShortcut;
    string output = "";

    public DesktopWidget(string root)
    {
        this.root = root;
        var profile = Environment.GetEnvironmentVariable("SCREEN_RECORDER_PROFILE") ??
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LocalScreenRecorder");
        Directory.CreateDirectory(profile);
        preference = Path.Combine(profile, "output-folder.txt");
        Text = Title;
        TopMost = true;
        FormBorderStyle = FormBorderStyle.FixedToolWindow;
        StartPosition = FormStartPosition.Manual;
        AutoScaleMode = AutoScaleMode.Dpi;
        ClientSize = new Size(375, 80);
        var screen = Screen.FromPoint(Cursor.Position);
        area = screen.Bounds;
        Location = new Point(screen.WorkingArea.Right - Width - 18, screen.WorkingArea.Top + 48);
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 5, RowCount = 2, Padding = new Padding(4) };
        Controls.Add(layout);
        foreach (var width in new float[] { 24, 19, 20, 19, 18 })
            layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, width));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 62));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 38));
        Button Add(string name, Action action, int col)
        {
            var button = new Button { Text = name, Dock = DockStyle.Fill, Margin = new Padding(1) };
            button.Click += (_, _) => Run(action);
            layout.Controls.Add(button, col, 0);
            return button;
        }
        record = Add("● 錄影", ToggleRecord, 0);
        pause = Add("暫停", TogglePause, 1);
        select = Add("框選", SelectArea, 2);
        Add("截圖", Screenshot, 3);
        Add("更多", () => menu.Show(this, new Point(ClientSize.Width - 100, 35)), 4);
        layout.Controls.Add(status, 0, 1);
        layout.SetColumnSpan(status, 5);
        ToolStripMenuItem Item(string label, Action action) =>
            (ToolStripMenuItem)menu.Items.Add(label, null, (_, _) => Run(action));
        audio = (ToolStripMenuItem)menu.Items.Add("錄音來源");
        for (int i = 0; i < AudioNames.Length; i++)
        {
            int source = i;
            var item = (ToolStripMenuItem)audio.DropDownItems.Add(AudioNames[i], null, (_, _) =>
            {
                audioMode = source;
                foreach (ToolStripMenuItem option in audio.DropDownItems)
                    option.Checked = option.Text == AudioNames[source];
                Ready();
            });
            item.Checked = i == 0;
        }
        reset = Item("使用滑鼠所在螢幕的全畫面", () => { area = Screen.FromPoint(Cursor.Position).Bounds; Ready(); });
        choose = Item("變更儲存資料夾…", ChooseFolder);
        Item("開啟儲存資料夾", () => Process.Start(new ProcessStartInfo(Folder()) { UseShellExecute = true }));
        advanced = Item("進階工作室（音訊、攝影機、裁切）", OpenStudio);
        Item("舊版媒體庫（取回舊錄影）", () =>
        {
            var legacyIndex = Path.Combine(root, "index.html");
            if (!File.Exists(legacyIndex))
                throw new FileNotFoundException("找不到舊版 index.html，請從原本的專案資料夾開啟舊版媒體庫。");
            var app = new ProcessStartInfo(EdgePath());
            app.ArgumentList.Add("--user-data-dir=" + Path.Combine(Path.GetDirectoryName(preference)!, "Profile"));
            app.ArgumentList.Add("--app=" + new Uri(legacyIndex).AbsoluteUri + "#library");
            Process.Start(app)?.Dispose();
        });
        timer.Tick += (_, _) => Run(() =>
        {
            if (recording == null || !clock.IsRunning) return;
            try { recording.Tick(clock.Elapsed.Ticks); }
            catch { Stop(); throw; }
            status.Text = $"錄影中　{clock.Elapsed:hh\\:mm\\:ss}　•　{AudioNames[audioMode]}";
        });
        Shown += (_, _) =>
        {
            SetWindowDisplayAffinity(Handle, 0x11);
            Ready();
        };
        FormClosing += (_, e) =>
        {
            if (recording == null) return;
            if (MessageBox.Show(this, "停止錄影、儲存並關閉？", Title, MessageBoxButtons.OKCancel) != DialogResult.OK)
                e.Cancel = true;
            else Run(Stop);
        };
    }

    void Run(Action action)
    {
        try { action(); }
        catch (Exception ex)
        {
            status.Text = "操作失敗";
            MessageBox.Show(this, ex.Message, Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
    void Ready()
    {
        pause.Enabled = false;
        status.Text = $"{area.Width} × {area.Height}　•　{AudioNames[audioMode]}　｜　更多可選錄音來源";
    }
    string Folder()
    {
        var path = File.Exists(preference) ? File.ReadAllText(preference).Trim() : "";
        if (!LocalPathGuard.IsValidLocalDirectory(path))
            path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyVideos), "桌面錄影室");
        if (!LocalPathGuard.IsValidLocalDirectory(path))
            throw new IOException("預設儲存資料夾並非本機路徑，請從「更多 → 變更儲存資料夾」選擇本機資料夾。");
        return Directory.CreateDirectory(path).FullName;
    }
    void ChooseFolder()
    {
        using var dialog = new FolderBrowserDialog { InitialDirectory = Folder(), Description = "選擇儲存資料夾" };
        if (dialog.ShowDialog(this) != DialogResult.OK) return;
        if (!LocalPathGuard.IsValidLocalDirectory(dialog.SelectedPath)) throw new IOException("請選擇本機資料夾（不支援網路磁碟或連結路徑）。");
        var temp = preference + "." + Guid.NewGuid();
        try { File.WriteAllText(temp, dialog.SelectedPath); File.Move(temp, preference, true); }
        finally { if (File.Exists(temp)) File.Delete(temp); }
        status.Text = dialog.SelectedPath;
    }
    string FileName(string prefix, string ext) =>
        Path.Combine(Folder(), $"{prefix}-{DateTime.UtcNow:yyyy-MM-ddTHH-mm-ss-fffffffZ}.{ext}");
    void ToggleRecord()
    {
        if (recording != null) { Stop(); return; }
        output = FileName("錄影", "mp4");
        recording = new DesktopRecording(area, output, audioMode);
        record.Text = "■ 停止";
        pause.Enabled = true;
        select.Enabled = reset.Enabled = audio.Enabled = advanced.Enabled = choose.Enabled = false;
        clock.Restart();
        hasShortcut = RegisterHotKey(Handle, 1, 0x4000, (uint)Keys.F9);
        Text = hasShortcut ? Title + " · F9 停止" : Title;
        timer.Start();
    }
    void Stop()
    {
        timer.Stop();
        clock.Stop();
        var session = recording!;
        recording = null;
        try { session.Finish(clock.Elapsed.Ticks); }
        finally
        {
            session.Dispose();
            if (hasShortcut) UnregisterHotKey(Handle, 1);
            Text = Title;
            record.Text = "● 錄影";
            pause.Text = "暫停";
            select.Enabled = reset.Enabled = audio.Enabled = advanced.Enabled = choose.Enabled = true;
            Ready();
        }
        status.Text = "已儲存 " + Path.GetFileName(output);
    }
    void TogglePause()
    {
        if (recording == null) return;
        if (clock.IsRunning) { recording.Tick(clock.Elapsed.Ticks); recording.PauseAudio(true); clock.Stop(); pause.Text = "繼續"; status.Text = "已暫停"; }
        else { recording.Tick(clock.Elapsed.Ticks); recording.PauseAudio(false); clock.Start(); pause.Text = "暫停"; }
    }
    protected override void WndProc(ref Message msg)
    {
        if (msg.Msg == 0x312 && msg.WParam == 1 && recording != null) { Run(Stop); return; }
        base.WndProc(ref msg);
    }
    void SelectArea()
    {
        using var picker = new RegionPicker();
        if (picker.ShowDialog(this) == DialogResult.OK) { area = picker.Selection; Ready(); }
    }
    void Screenshot()
    {
        using var image = new Bitmap(area.Width, area.Height);
        using (var g = Graphics.FromImage(image)) g.CopyFromScreen(area.Location, Point.Empty, area.Size);
        string file = FileName("截圖", "png");
        image.Save(file, ImageFormat.Png);
        status.Text = "已儲存 " + Path.GetFileName(file);
    }
    static string EdgePath() => new[] { Environment.SpecialFolder.ProgramFilesX86, Environment.SpecialFolder.ProgramFiles }
            .Select(p => Path.Combine(Environment.GetFolderPath(p), "Microsoft", "Edge", "Application", "msedge.exe"))
            .FirstOrDefault(File.Exists) ?? throw new FileNotFoundException("進階工作室需要 Microsoft Edge。");
    void OpenStudio()
    {
        var start = new ProcessStartInfo(Environment.ProcessPath!);
        start.ArgumentList.Add(root);
        start.ArgumentList.Add(EdgePath());
        Process.Start(start)?.Dispose();
        status.Text = "已開啟進階工作室";
    }
    protected override void Dispose(bool disposing)
    {
        if (disposing) { timer.Dispose(); menu.Dispose(); recording?.Dispose(); }
        base.Dispose(disposing);
    }
}

sealed class RegionPicker : Form
{
    Point? start;
    public Rectangle Selection { get; private set; }
    public RegionPicker()
    {
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        Bounds = SystemInformation.VirtualScreen;
        BackColor = Color.Black;
        ForeColor = Color.White;
        Opacity = 0.42;
        Cursor = Cursors.Cross;
        TopMost = true;
        ShowInTaskbar = false;
        DoubleBuffered = true;
        KeyDown += (_, e) => { if (e.KeyCode == Keys.Escape) DialogResult = DialogResult.Cancel; };
        MouseDown += (_, e) => { if (e.Button == MouseButtons.Left) { start = e.Location; Capture = true; } };
        MouseMove += (_, _) => { if (start.HasValue) Invalidate(); };
        MouseUp += (_, e) =>
        {
            if (start is not Point from || e.Button != MouseButtons.Left) return;
            Capture = false;
            var rect = Box(from, e.Location);
            start = null;
            if (rect.Width < 4 || rect.Height < 4) { Invalidate(); return; }
            Selection = RectangleToScreen(rect);
            DialogResult = DialogResult.OK;
        };
    }
    static Rectangle Box(Point a, Point b) => Rectangle.FromLTRB(Math.Min(a.X,b.X), Math.Min(a.Y,b.Y), Math.Max(a.X,b.X), Math.Max(a.Y,b.Y));
    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        var p = PointToClient(Cursor.Position);
        if (start is Point from) e.Graphics.DrawRectangle(Pens.White, Box(from, p));
        TextRenderer.DrawText(e.Graphics, "拖曳選取錄影範圍　Esc 取消", Font, new Point(p.X + 15,p.Y + 15), Color.White);
    }
}
