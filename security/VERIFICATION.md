# Release verification — OpenChatCut 0.2.14 (hardened), Windows x64

Built on 2026-09-27 from commit `d424cbe` (branch
`claude/eager-albattani-2tprvr`) in a fresh clone with `npm ci` on Linux
(Node 24.21.0, Wine 9.0), using `npm run desktop:dist:win:all`. Later commits
change only documentation.

## Distributables

| File | Size (bytes) | SHA-256 |
|---|---|---|
| `OpenChatCut-0.2.14-x64.exe` (NSIS installer + uninstaller) | 707,638,008 | `6552aecc65f0112f9e5423b3f2c057af4544104560b9233696272af9c78a0615` |
| `OpenChatCut-Portable-0.2.14-x64.exe` (portable) | 707,369,361 | `e3af33c622aea8c96c894789d5eb07d7bc05f9dd917ee59ba730eac030700d7f` |

Key contents:

| File in package | SHA-256 |
|---|---|
| `OpenChatCut.exe` | `64126c2258958b6480dfea209aa389dcbf5b04739a4472222f54f51e59cc82aa` |
| `resources/app.asar` | `ec4d625062872c4474ac925d90caaa4022d3dfb0b4c9eb87f3fa85a3ef9f6ffc` |
| `ffmpeg.exe` (ffmpeg-static b6.1.1) | `04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00` |
| `ffprobe.exe` | `f28c4751e7367205267025aaf0fcfc921e34d9b7edaa46bd9c8abaf367fc9051` |
| `chrome-headless-shell.exe` 149.0.7790.0 (byte-identical to Google's Chrome for Testing download) | `ec76dc3e69ffab9daddf0bbe7bf0a9e0a034b2d086741a0ae2ef6358a597537b` |
| `whisper-cli.exe` v1.9.2 (from the release archive pinned at `49dcc16d…674a`) | `95e3c0b0e778ad9499eb0125f97c1dcf437dd9eb4ea77050b043574f93c2631d` |
| Electron 43.1.1 source zip (verified against Electron's SHASUMS256) | `b4e9995cd3f65785eb8818276aa9020f3165ab11da41b3c762616d4a0ad8c7ad` |

`OpenChatCut.exe` and `app.asar` were byte-identical across two independent
clean builds. The installer's and the portable executable's embedded payload
archive (`app-64.7z`, SHA-256 `6dda34eb…dbf8c` in the validation build) are
identical to each other. All 2,748 extracted files match the scanned
`win-unpacked` tree by SHA-256.

## Package checks

| Check | Result |
|---|---|
| Version resources | ProductName OpenChatCut, FileVersion 0.2.14, CompanyName "OpenChatCut Contributors" on app, installer and portable |
| Requested execution level (manifest) | `asInvoker` on app, installer and portable (no elevation) |
| Installer mode | per-user default (`perMachine: false`); UAC only if the user picks "all users" |
| Authenticode signature | **none** (unsigned; see CODE_SIGNING.md) |
| Electron fuses (read from `OpenChatCut.exe`) | RunAsNode **Disabled**, NODE_OPTIONS **Disabled**, inspect args **Disabled**, EmbeddedAsarIntegrityValidation **Enabled**, OnlyLoadAppFromAsar **Enabled**, CookieEncryption **Enabled**, file:// extra privileges **Disabled** |
| Foreign-OS binaries (ELF / Mach-O) in package | 0 |
| Source maps in the editor bundle | 0 (the Remotion render bundle keeps `bundle.js.map`, which the renderer reads) |
| Development server / dev URL | not packaged; `CC_DESKTOP_DEV_URL` ignored when packaged |
| Secrets (gitleaks 8.28 on main-process bundles, renderer bundle, render bundle) | no project secrets. False positives: settings-panel identifiers, and Remotion Studio's public Algolia search-only key embedded in Remotion's source |
| Credential files (`.env`, `.pem`, `.pfx`, `id_rsa`, `.npmrc`) in package | none |
| Private keys in shipped JS | none (only PEM parser strings in `jose`, and TLS strings inside the FFmpeg binaries) |
| `npm audit` | 0 vulnerabilities (972 packages) |
| Registry | all 972 lockfile URLs from registry.npmjs.org |

## Malware scanning

- **Scanner:** ClamAV 1.5.4 (`clamscan`). Signatures: daily 28129 (built
  2026-09-20, 7 days old at scan time; the live update server is blocked by
  this environment's network policy, so the signed databases were taken from
  the official `clamav/clamav:stable` image, and ClamAV verified their
  digital signatures on load). The engine detects the EICAR test file.
- **Scope:** the unpacked application (all files), every file extracted from
  `app.asar`, and both distributables (archive scanning, 2 GB limits); 24,464 files, 3.84 GiB scanned.
- **Result:** 2 detections, both
  `Win.Packed.Mikey-9859574-0` (a generic logical signature matching common
  x64 prologue/epilogue sequences plus PE-header parsing code):
  `OpenChatCut.exe` and `chrome-headless-shell.exe`. Every other file: no
  detections. The NSIS installer's own plugins and uninstaller: 0 of 9.
- **Assessment:** the same signature fires on the **official, unmodified**
  Electron 43.1.1 `electron.exe` (verified against Electron's published
  SHA-256) and on Google's Chrome for Testing `chrome-headless-shell.exe`
  (byte-identical to the shipped file). The detection comes from upstream
  Chromium code, not from anything this build adds. This is a heuristic
  false-positive assessment; it is **not** a proof of absence of malware.
- **Not available here:** Microsoft Defender and other commercial engines
  cannot run in this Linux environment. Before distribution, scan both `.exe`
  files with Microsoft Defender on Windows and with VirusTotal, and publish the
  report links next to the checksums.

**Malware-free status has not been proven.** Only the ClamAV results above
were obtained.

## Tests

| Suite | Result |
|---|---|
| Security regression suites (`npm run verify:security`, 4 suites) | pass: 34 template-sandbox escape payloads blocked; all 235 bundled templates compile; capability broker, path safety, audit redaction, front-door gate, skill-exec, settings, local paths, CapCut export, Electron configuration |
| Full repository suite (`pretest` + `test:serial` + `posttest`, 631 commands) | 626 pass. 5 fail **identically on the unmodified base commit** because this environment's egress policy blocks `remotion.media` and HuggingFace downloads (`notoSansOffline`, `hf-proxy`, `video-decoder-render`, `clipFxExport`, `clipFxExport.offthread`) |
| Typecheck (`tsc -b`), lint (`oxlint`) | clean |
| Packaged Linux build smoke (same code, `CC_SMOKE=1 CC_SMOKE_RENDER=1`, Xvfb, unprivileged user, fresh profile) | **SMOKE-OK**: embedded server, external MCP endpoint, security boundaries (anonymous request → 403, no Node.js in the page, CSP blocked an injected inline script, `window.open` denied), sandboxed preload APIs, a real frame render through the bundled Chrome Headless Shell + compositor. The audit log recorded the rejected request and the blocked popup |
| Windows build under Wine 9 | main process, embedded server and editor window start. The smoke probe's Node-side `fetch` fails under Wine's network emulation, so the full Windows smoke must run on real Windows (`.github/workflows/windows-hardened.yml`, or the existing `desktop.yml` Windows job) |

The cross-build found and fixed two packaging defects that a native Windows
build would not show: missing Windows native bindings for
rspack/esbuild, and the Windows whisper runtime not reaching `dist/`.

## Not verified here

- The installer/uninstaller UI flow and the packaged smoke test on physical
  Windows 10/11 (run the Windows workflow).
- SmartScreen/Defender behavior (unsigned builds trigger SmartScreen).
- GPU/hardware-encoder paths (no GPU in this environment).
