@echo off
setlocal
cd /d "%~dp0"
for /f "usebackq tokens=*" %%i in (`"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VS=%%i"
if not defined VS exit /b 1
call "%VS%\VC\Auxiliary\Build\vcvars64.bat" || exit /b 1
if not exist FolderHost\obj mkdir FolderHost\obj
cl /std:c++17 /nologo /EHsc /O2 /MT /LD FolderHost\native\Encoder.cpp /Fo:FolderHost\obj\Encoder.obj /link /implib:FolderHost\obj\Encoder.lib /out:FolderHost\obj\DesktopEncoder.dll mfplat.lib mfreadwrite.lib mfuuid.lib ole32.lib || exit /b 1
dotnet publish FolderHost\FolderHost.csproj -c Release -o folder-runtime || exit /b 1
copy /y FolderHost\obj\DesktopEncoder.dll folder-runtime\DesktopEncoder.dll >nul || exit /b 1
dotnet publish FolderHost\FolderHost.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:EnableCompressionInSingleFile=true -p:AssemblyName=Recorder --source https://api.nuget.org/v3/index.json -o FolderHost\obj\singlefile || exit /b 1
copy /y FolderHost\obj\singlefile\Recorder.exe Recorder.exe >nul || exit /b 1
powershell -NoProfile -ExecutionPolicy Bypass -File FolderHost.verify.ps1
exit /b %errorlevel%
