$ErrorActionPreference = 'Stop'
$work = Join-Path $env:TEMP ([guid]::NewGuid().ToString())
New-Item -Type Directory $work | Out-Null
$env:SCREEN_RECORDER_PROFILE = $work
$env:SCREEN_RECORDER_PORT = '0'
$env:SCREEN_RECORDER_ALLOW_TEST_LAUNCHER = '1'
$target = Join-Path $work 'output with spaces'
[IO.File]::WriteAllText((Join-Path $work 'output-folder.txt'), "$target`r`n")
Add-Type -TypeDefinition 'using System; using System.IO; class Launch { public static void Main(string[] a){File.WriteAllText(Path.Combine(Environment.GetEnvironmentVariable("SCREEN_RECORDER_PROFILE"),"url"), a[a.Length-1]);}}' -OutputAssembly "$work\Launch.exe" -OutputType ConsoleApplication
$process = Start-Process "$PSScriptRoot\folder-runtime\FolderHost.exe" -ArgumentList ('"{0}" "{1}\Launch.exe"' -f $PSScriptRoot,$work) -PassThru
try {
  for($i=0;$i -lt 100 -and !(Test-Path "$work\url");$i++){Start-Sleep -Milliseconds 100}
  $launch = [IO.File]::ReadAllText("$work\url")
  if ($launch -notmatch '^--app=(http://127\.0\.0\.1:\d+)/launch\?t=([A-F0-9]{64})$'){throw 'Invalid launch URL format'}
  $origin = $matches[1]
  $launchUrl = "$origin/launch?t=$($matches[2])"

  $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  Invoke-WebRequest $launchUrl -UseBasicParsing -WebSession $session | Out-Null

  # Replay of one-time launch token must fail with 403
  try { Invoke-WebRequest $launchUrl -UseBasicParsing; throw 'Launch token was reusable' }
  catch [Net.WebException] { if([int]$_.Exception.Response.StatusCode -ne 403){throw} }

  $headers = @{'Origin'=$origin;'X-Studio-Client'='1'}
  $actual = (Invoke-WebRequest "$origin/api/folder" -UseBasicParsing -Method Post -Headers $headers -WebSession $session).Content
  if($actual -ne $target){throw "Incorrect destination: $actual"}

  # Origin: null must be rejected
  try { Invoke-WebRequest "$origin/api/folder" -UseBasicParsing -Method Post -Headers @{'Origin'='null';'X-Studio-Client'='1'} -WebSession $session; throw 'Origin null was accepted' }
  catch [Net.WebException] { if([int]$_.Exception.Response.StatusCode -ne 403){throw} }

  # Valid MP4 magic bytes
  $name = [char]0x9304 + [string][char]0x5F71 + '-2026-11-23T13-00-00.000Z.mp4'
  $uri = "$origin/api/save?name=" + [uri]::EscapeDataString($name)
  $source = "$work\input.mp4"
  $bytes = New-Object byte[] 90001
  (New-Object Random 42).NextBytes($bytes)
  $bytes[0]=0; $bytes[1]=0; $bytes[2]=0; $bytes[3]=24
  $bytes[4]=0x66; $bytes[5]=0x74; $bytes[6]=0x79; $bytes[7]=0x70
  [IO.File]::WriteAllBytes($source,$bytes)
  Invoke-WebRequest $uri -Method Post -Headers $headers -WebSession $session -InFile $source -ContentType 'video/mp4' -UseBasicParsing | Out-Null
  if((Get-FileHash $source).Hash -ne (Get-FileHash (Join-Path $target $name)).Hash){throw 'Corrupted bytes'}

  # Invalid magic bytes must be rejected with 400
  $badUri = "$origin/api/save?name=" + [uri]::EscapeDataString(([char]0x9304 + [string][char]0x5F71 + '-2026-11-23T13-00-01.000Z.mp4'))
  try { Invoke-WebRequest $badUri -Method Post -Headers $headers -WebSession $session -Body 'not-an-mp4-file' -UseBasicParsing; throw 'Invalid magic bytes accepted' }
  catch [Net.WebException] { if([int]$_.Exception.Response.StatusCode -ne 400){throw} }

  # Duplicate filename must return 409 and leave no temp files
  try { Invoke-WebRequest $uri -Method Post -Headers $headers -WebSession $session -InFile $source -ContentType 'video/mp4' -UseBasicParsing; throw 'Unexpected overwrite' }
  catch [Net.WebException] { if([int]$_.Exception.Response.StatusCode -ne 409){throw} }
  if((Get-ChildItem $target -Force).Count -ne 1){throw 'Temporary file left over'}

  # Clean shutdown
  Invoke-WebRequest "$origin/api/shutdown" -Method Post -Headers @{'Origin'=$origin} -WebSession $session -UseBasicParsing | Out-Null
  Write-Host 'Passed: one-time launch token, cookie+origin auth, magic bytes, collision handling, cleanup and shutdown.'
} finally {
  if(!$process.HasExited){$process.Kill(); $process.WaitForExit()}
  Remove-Item -LiteralPath $work -Recurse -Force
}
