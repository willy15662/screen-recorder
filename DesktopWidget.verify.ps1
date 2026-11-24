$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class WidgetTest {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr child, IntPtr cls, IntPtr title);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr w, uint m, IntPtr a, IntPtr b);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr w, out uint process);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr w);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr w, uint msg, IntPtr length, StringBuilder title);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
[void][WidgetTest]::SetProcessDPIAware()
$zero = [IntPtr]::Zero
$work = Join-Path $PSScriptRoot ("FolderHost/obj/widget-test-" + [guid]::NewGuid())
New-Item -ItemType Directory $work | Out-Null
$env:SCREEN_RECORDER_PROFILE = $work
[IO.File]::WriteAllText((Join-Path $work 'output-folder.txt'),$work)
function Pump($ms) {
  $timer=[Diagnostics.Stopwatch]::StartNew()
  while ($timer.ElapsedMilliseconds -lt $ms) { [Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 10 }
}
function Windows($parent) {
  $w=$zero
  while (($w=[WidgetTest]::FindWindowEx($parent,$w,$zero,$zero)) -ne $zero) { $w }
}
function Title($w) { $s=New-Object Text.StringBuilder 200; [void][WidgetTest]::SendMessage($w,0xD,[IntPtr]200,$s); $s.ToString() }
function Button($parent,$label) {
  foreach($w in (Windows $parent)) {
    if ((Title $w) -eq $label) { return $w }
    $child=Button $w $label
    if ($child) {return $child}
  }
}
function Click($label) {
  for ($retry=0;$retry -lt 12;$retry++){ $button=Button $widget $label; if($button){break}; Pump 100 }
  if (!$button) { throw "Missing control $label. Window: $(Title $widget). Children: $((Windows $widget | ForEach-Object { Title $_ }) -join '/')" }
  [void][WidgetTest]::PostMessage($button,0xf5,$zero,$zero)
  Pump 220
}
$fixture = New-Object Windows.Forms.Form
$fixture.FormBorderStyle='None'
$fixture.StartPosition='Manual'
$fixture.Bounds=New-Object Drawing.Rectangle 80,80,360,260
$fixture.BackColor=[Drawing.Color]::Red
$bottom=New-Object Windows.Forms.Panel
$bottom.Dock='Bottom'; $bottom.Height=130; $bottom.BackColor=[Drawing.Color]::Blue
$fixture.Controls.Add($bottom)
$fixture.TopMost=$true
$fixture.Show()
try {
  $process=Start-Process "$PSScriptRoot/folder-runtime/FolderHost.exe" -ArgumentList ('"{0}" --widget' -f $PSScriptRoot) -PassThru
  for($i=0;$i -lt 60;$i++) { Pump 100; $process.Refresh(); $widget=$process.MainWindowHandle; if($widget -ne $zero){break}; if($process.HasExited){throw 'Close the existing widget before the test.'} }
  Click '框選'
  $picker=Windows $zero | Where-Object {
    [uint32]$owner=0
    [void][WidgetTest]::GetWindowThreadProcessId($_,[ref]$owner)
    $owner -eq $process.Id -and $_ -ne $widget -and [WidgetTest]::IsWindowVisible($_) -and (Title $_) -eq ''
  } | Select-Object -First 1
  if (!$picker){throw 'Region picker missing'}
  # Only select pixels inside the test pattern, including on a multi-monitor desktop.
  $origin=[Windows.Forms.SystemInformation]::VirtualScreen.Location
  $a=[IntPtr](((100-$origin.Y) -shl 16) -bor ((100-$origin.X) -band 65535))
  $b=[IntPtr](((300-$origin.Y) -shl 16) -bor ((400-$origin.X) -band 65535))
  [void][WidgetTest]::PostMessage($picker,0x201,[IntPtr]1,$a)
  [void][WidgetTest]::PostMessage($picker,0x202,$zero,$b)
  Pump 250
  Click '截圖'
  $png=Get-ChildItem $work -Filter *.png | Select-Object -First 1
  $image=[Drawing.Bitmap]::FromFile($png.FullName)
  try { if($image.Width -ne 300 -or $image.Height -ne 200 -or $image.GetPixel(50,30).R -lt 200 -or $image.GetPixel(50,170).B -lt 200){throw 'Incorrect capture rectangle or orientation'} } finally { $image.Dispose() }
  Click '● 錄影'
  Pump 800
  Click '暫停'
  Pump 550
  Click '繼續'
  Pump 800
  Click '■ 停止'
  for($i=0;$i -lt 40;$i++) { $mp4=Get-ChildItem $work -Filter '錄影-*.mp4' | Select-Object -First 1; if($mp4){break}; Pump 100 }
  if (!$mp4 -or $mp4.Length -lt 1000){ throw 'No completed video' }
  Write-Output ("Passed native region, screenshot pixels, recording, pause, resume, stop: " + $mp4.FullName)
} finally {
  if($process -and !$process.HasExited){ [void]$process.CloseMainWindow(); if(!$process.WaitForExit(2000)){$process.Kill()} }
  $fixture.Dispose()
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
