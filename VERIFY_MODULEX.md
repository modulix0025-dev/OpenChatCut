# ModuleX verification

## Release

- **Windows build (GitHub Actions):**
  [run 36342351010](https://github.com/modulix0025-dev/OpenChatCut/actions/runs/36342351010),
  commit `9c17d61`. Every step passed:
  - `npm audit`
  - the security regression suite
  - packaging
  - fuse and runtime-file checks
  - a silent install
  - the packaged smoke test on the installed app: security boundaries,
    `app.log` written, and a real frame render
  - uninstall
- **Release:**
  [hardened-0.2.14-run36342351010](https://github.com/modulix0025-dev/OpenChatCut/releases/tag/hardened-0.2.14-run36342351010)

| File | SHA-256 |
|---|---|
| `OpenChatCut-0.2.14-x64.exe` | `5142f39f57e30a1ec145b33c42ecd9005c130a24c703ab33ac64216b2ac63c12` |
| `OpenChatCut-Portable-0.2.14-x64.exe` | `e86336dc632a5610202550619df97392cf71f8bc37bdb30d291d9a89faaca528` |

The executables are unsigned.

## Automated tests

Every `pretest`, `test:serial` and `posttest` command was run one at a time
on Linux (623 commands), with 615 passing.

| Failed | Reason |
|---|---|
| `src/components/settings/settingsStorage.verify.ts`, `src/i18n/dictRegistry.verify.ts`, `scripts/verify-gate-coverage.verify.mjs` | The tests still expected the old behavior. Updated after the run in `6fb8cc3` and `f916883`, and each now passes on its own. |
| `src/fonts/notoSansOffline.verify.ts`, `server/plugins/hf-proxy.verify.ts`, `remotion/video-decoder-render.verify.mjs`, `src/gl/clipFxExport.verify.mjs`, `src/gl/clipFxExport.offthread.verify.mjs` | They download from `remotion.media` / Hugging Face, which this environment's network policy blocks. They fail the same way on the unmodified upstream commit. |

`desktop/embedded-project-store-http.verify.ts` fails under this
environment's HTTP proxy variables and passes with them unset (upstream
behaves the same). The run above had them unset.

### Regression test per fix

| Fix | Test | Fails on the old code |
|---|---|---|
| F1/F2 AbsoluteFill scenes render | `src/template-host.security.verify.ts` | yes (scene rendered empty) |
| F3 AAC without libfdk_aac | `remotion/direct-hardware.verify.mjs` | yes |
| F4 loopback media in export | `server/loopback-media.verify.ts` | yes |
| F5 add_audio frame and duration | `src/agent/tools/audio-assets.verify.ts` | yes |
| F6 MCP sessions across edits | `server/external-agent/mcp.verify.ts`, `src/agent/external-edit-session-runtime.verify.ts` | yes |
| F7 storage move at startup | `server/data-dir-relocation.verify.ts` | new module |
| F8 project names | `src/persist/defaultProjectName.verify.ts` | yes |
| F9 2 MB ffprobe metadata | `server/process-output.verify.ts` | yes, with the same JSON error as on Windows |
| F10 app.log | `desktop/app-log.verify.ts` + packaged smoke on Windows | new module |
| F11 ComfyUI | `server/plugins/comfyui.verify.ts` (fake ComfyUI API) | new module |
| F12 Opus 5.5 | `server/claude-code/models.verify.ts` | yes |
| F13 denials / idle notice | `server/claude-code/claude-code-agent.verify.ts`, `server/agent-runs/claude-code-turn.verify.ts` | yes |
| F14 copy on import | `desktop/local-media-import.verify.ts` | yes |
| F15 render bundle integrity | `desktop/packaged-runtime.verify.ts` | yes |
| F16 i18n / Arabic | `npm run verify:i18n`, plus headless Chromium: dashboard and editor in Arabic, `dir=rtl`, no Chinese text on the page | n/a |

## Manual checks on the user's machine (not run yet)

These need the user's Windows machine, files and ComfyUI server; they could
not be run from the build environment.

| Check | Result |
|---|---|
| a) Import the original `Downloads\LTX-2.5_i2v_00020_.mp4` (not the cleaned copy): it stays in the library | pending |
| b) Open "إعلان KidX ٣٠ ثانية": seven scenes visible; H.264 export with audio succeeds | pending |
| c) A scene rooted in `<AbsoluteFill>` is visible | pending |
| d) Opus 5.5 in the model list; a simple turn finishes without a 600 s wait | pending |
| e) Image from a ComfyUI workflow (local or rented box) lands in the library | pending |
| f) `app.log` has a trace of each check above | pending |

## Not done

- **In-chat approval card (F13):** privileged actions use the native
  permission dialog, and the idle notice points to it.
- **Upstream's model catalog:** not refreshed here (models.dev is blocked in
  this environment). Opus 5.5 and Fable 5.1 are listed as models newer than
  the snapshot.
