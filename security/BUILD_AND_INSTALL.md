# Building and installing the Windows desktop app

## Installing (end users)

Two x64 downloads are produced. Neither requires Node.js, npm, Python, Git,
FFmpeg or a compiler; everything the app runs is bundled.

| File | What it is |
|---|---|
| `OpenChatCut-<version>-x64.exe` | Installer (NSIS) with uninstaller, Start-menu and desktop shortcuts |
| `OpenChatCut-Portable-<version>-x64.exe` | Single-file portable build; nothing is installed |

1. **Verify the download.** Compare its SHA-256 with the published checksum:
   ```powershell
   Get-FileHash .\OpenChatCut-<version>-x64.exe -Algorithm SHA256
   ```
2. **Run the installer.** The build is unsigned (see CODE_SIGNING.md), so
   SmartScreen shows "Windows protected your PC". Choose *More info → Run
   anyway* only if the checksum matched.
3. Choose **"Only for me"** (the default). This installs into
   `%LOCALAPPDATA%\Programs\OpenChatCut` without administrator rights.
   "Anyone who uses this computer" installs into Program Files and is the only
   option that triggers a UAC prompt.
4. Launch OpenChatCut from the Start menu. It runs as your normal user.

**Portable:** double-click the portable `.exe`. It unpacks to a temporary
folder and runs as your user. Settings and projects are still stored in
`%APPDATA%\OpenChatCut`, so it is portable as a program, not as a data folder.

**Where data lives**

| Path | Contents |
|---|---|
| `%LOCALAPPDATA%\Programs\OpenChatCut` | Program files (read-only in use) |
| `%APPDATA%\OpenChatCut` | Settings (`.env.local`, owner-only), project store, render bundle copy, `logs\security-audit.log`, `security\capability-grants.json` |
| `%USERPROFILE%\.openchatcut` | MCP token (`mcp-token`), port memory, skills, model cache |

**Uninstall:** *Settings → Apps → OpenChatCut → Uninstall*, or `Uninstall
OpenChatCut.exe` in the install folder. Your projects and settings are kept by
default; delete the folders above to remove them.

**Reset permissions:** quit OpenChatCut and delete
`%APPDATA%\OpenChatCut\security\capability-grants.json`. Folders granted to the
agent are listed as *agent import roots* in Settings.

## Building from source

### On Windows (native)

Requirements: Windows 10/11 x64, Node.js 24, Git.

```powershell
git clone <repo> OpenChatCut; cd OpenChatCut
$env:ONNXRUNTIME_NODE_INSTALL = 'skip'
npm ci
npm test                       # optional; includes npm run verify:security
npm run desktop:dist:win:all   # installer + portable → release\
```

`npm run desktop:dist:win` builds only the installer (the release feed
artifact).

### On Linux (cross-build, how the published artifacts were produced)

Requirements: Node.js 24, `unzip`, Wine 9 with **both** 64- and 32-bit support
(`wine64`, `wine32:i386`), and a 64-bit Wine prefix:

```bash
sudo dpkg --add-architecture i386 && sudo apt-get update
sudo apt-get install -y wine64 wine32:i386 unzip
WINEARCH=win64 wineboot --init
export ONNXRUNTIME_NODE_INSTALL=skip
npm ci
npm run desktop:dist:win:all
```

Wine is used by electron-builder to stamp the icon and version resources and
to generate the NSIS uninstaller. For `win32-x64` on a non-Windows host,
`desktop/prepare-target.mts` also stages:

- the Windows variants of the native npm packages, at lockfile versions,
  verified against lockfile integrity;
- `ffmpeg.exe`;
- the SHA-256-pinned whisper.cpp release;
- Chrome Headless Shell for Windows.

### Pipeline

`npm run build` (typecheck + Vite production build; runs the shader, MediaPipe
and whisper provisioning checks first) → `desktop:build:main` (esbuild bundles
of the main process, preload and workers) → `desktop:prebundle` (Remotion
render bundle) → `prepare-target win32-x64` → `electron-builder --win nsis
portable`.

The production build contains no development server. The dev-server URL
(`CC_DESKTOP_DEV_URL`) is ignored when packaged. Source maps of the editor and
of dependencies are excluded, and binaries for other operating systems are
filtered out. Electron fuses are flipped in the executable.

### Verifying a build

```bash
sha256sum release/*.exe
# Packaged smoke test (needs a display; CI runs this on real Windows):
CC_SMOKE=1 CC_SMOKE_RENDER=1 release/win-unpacked/OpenChatCut.exe
```

The smoke test checks the embedded server, the external MCP endpoint, the
security boundaries (session gate, no Node.js in the page, CSP, no popups), the
preload APIs and a real frame render.
