# 桌面錄影室（Screen Recorder）

[![下載 Recorder.exe](https://img.shields.io/badge/%E4%B8%8B%E8%BC%89-Recorder.exe%20(Windows%20x64)-0078D4?style=for-the-badge&logo=windows)](https://github.com/willy15662/screen-recorder/releases/latest/download/Recorder.exe)

> 免安裝單一執行檔（Windows 10／11 x64）｜[查看所有版本與 SHA-256 校驗碼](https://github.com/willy15662/screen-recorder/releases)

Windows 10／11 x64 的本機錄影與截圖工具。雙擊 `Recorder.exe` 即可開啟置頂的「桌面錄影小工具」。需要錄製單一視窗或分頁、混合音訊或加入攝影機畫面時，可從小工具切換至「進階工作室」。兩種模式都能離線使用，錄影與截圖直接儲存在本機，無須上傳雲端。

## 快速開始

1. 將 `Recorder.exe` 複製到 Windows 10／11 x64 電腦，雙擊執行。這個獨立執行檔已包含 .NET 10 執行階段、原生 C++ 編碼器 DLL 與工作室前端資源，免安裝，也無須複製其他專案檔案。
2. 選擇全螢幕或拖曳框選錄影範圍，按 **錄影** 開始。錄製期間可暫停與繼續。完成後按全域快捷鍵 **F9** 停止並儲存 MP4。若只需一張圖片，按 **截圖** 即可儲存 PNG。
3. 從 **更多 → 開啟儲存資料夾** 查看成品。預設位置為 Windows 使用者的 `影片\桌面錄影室`，可從 **更多 → 變更儲存資料夾** 指定其他本機資料夾。

**開啟進階工作室**　電腦需已安裝 Microsoft Edge。在小工具選擇 **更多 → 進階工作室（音訊、攝影機、裁切）**，即可在獨立的 Edge 應用程式視窗中錄製。

**以開發模式啟動**　在專案根目錄執行 `Recorder.cmd`，腳本會啟動 `folder-runtime\FolderHost.exe` 並開啟桌面小工具。

## 桌面錄影小工具

| 功能 | 操作與規格 |
| --- | --- |
| 擷取範圍 | 全螢幕模式會自動選擇滑鼠所在的螢幕。自訂範圍時，以滑鼠拖曳框選，按 Esc 可取消選取。 |
| 懸浮控制 | 原生 WinForms 小工具保持置頂，透過 `SetWindowDisplayAffinity` 將控制介面排除於擷取畫面之外。 |
| 影片編碼 | 原生 C++ 編碼器使用 Windows Media Foundation 將影像編碼為 H.264 並寫入 MP4。超過 1080p 的畫面會自動縮小。 |
| 錄音來源 | 可選無聲、系統聲音（WASAPI Loopback）或麥克風（WASAPI Capture）。啟用錄音時使用 48 kHz 立體聲 AAC。 |

小工具會將儲存資料夾的位置記在 `%LOCALAPPDATA%\LocalScreenRecorder\output-folder.txt`，下次啟動時沿用。

## 進階工作室

| 功能 | 可用選項 |
| --- | --- |
| 畫面與標註 | 擷取整個螢幕、單一視窗或瀏覽器分頁。可拖曳框選錄影區域，並以畫筆即時標註、選色、復原或清除筆跡。 |
| 聲音與攝影機 | 可混合系統聲音與麥克風，選擇輸入裝置並透過即時音量計確認收音。攝影機子母畫面可置於左下角或右下角。 |
| 畫質與影格率 | 位元率可選 2.5、5 或 12 Mbps，影格率可選 15、30 或 60 FPS。 |
| 錄製控制 | 可設定 3 秒或 5 秒的開始倒數，指定自動停止時間，並透過浮動控制列操作錄影。 |
| 匯出與檢視 | 使用 mediabunny 匯出 MP4，並在媒體庫檢視錄製內容。 |

工作室以 ASP.NET Core 在本機 `127.0.0.1` 提供服務。啟動時使用一次性啟動權杖（Launch Token）建立工作階段，後續請求透過 HttpOnly Cookie 與 Origin 驗證（除 `/api/shutdown` 外亦要求自訂標頭）。存檔 API 以嚴格檔名白名單防止路徑穿越、以新建暫存檔與不覆寫搬移防止覆寫既有檔案，並在串流初期檢查 PNG 與 MP4 的檔案識別位元組（magic bytes）。進階工作室另會將錄影副本保存於瀏覽器的 IndexedDB 媒體庫，刪除輸出資料夾的 MP4 後，媒體庫副本須另外清除。

## 專案結構

| 路徑 | 用途 |
| --- | --- |
| `Recorder.exe` | 約 61 MiB 的壓縮單檔發行版（win-x64，self-contained）。 |
| `Recorder.cmd`、`folder-runtime/` | 開發模式啟動腳本及其使用的資料夾版執行環境。 |
| `Build.cmd` | 編譯原生 DLL、發佈資料夾版與單檔版，並執行主程式驗證。 |
| `FolderHost/` | .NET 10 Windows 主程式。`Program.cs` 處理啟動與本機服務，`DesktopWidget.cs` 實作小工具介面，`DesktopRecording.cs` 負責桌面錄製流程。 |
| `FolderHost/native/` | `Encoder.cpp` 實作原生編碼器，`DesktopAudio.h` 負責桌面錄音。 |
| `index.html`、`studio.css`、`studio.js` | 進階工作室的頁面、樣式與介面操作。 |
| `recorder.js`、`mp4.js`、`vendor/mediabunny-1.29.1.js` | 工作室的錄製與 MP4 匯出。 |
| `storage.js`、`folders.js` | 工作室的媒體儲存與資料夾操作。 |
| `FolderHost.verify.ps1`、`DesktopWidget.verify.ps1` | 主程式與桌面小工具的自動化驗證腳本。 |

## 從原始碼建置與驗證

在 Windows 10／11 x64 上安裝 **Visual Studio Build Tools**（含 C++ x64 工具組）與 **.NET 10 SDK**。在專案根目錄開啟 PowerShell，執行下列指令建置：

```powershell
.\Build.cmd
```

腳本會編譯 `DesktopEncoder.dll`，將資料夾版發佈至 `folder-runtime\`，在根目錄產生單檔版 `Recorder.exe`，最後執行 `FolderHost.verify.ps1`。

若要驗證小工具的框選、截圖、錄影、暫停、繼續與停止流程，請另行執行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File DesktopWidget.verify.ps1
```
