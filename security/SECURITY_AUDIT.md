# OpenChatCut Windows desktop — security audit and hardening report

Base: `404da7c` (v0.2.14). Hardened: this branch. Companion documents:
[THREAT_MODEL.md](THREAT_MODEL.md) (risk register traced to code),
[PERMISSION_MODEL.md](PERMISSION_MODEL.md),
[DEPENDENCY_REPORT.md](DEPENDENCY_REPORT.md),
[CODE_SIGNING.md](CODE_SIGNING.md),
[BUILD_AND_INSTALL.md](BUILD_AND_INSTALL.md),
[VERIFICATION.md](VERIFICATION.md) (artifacts, hashes, test and scan results).

This report does not claim the application is "100% secure" or proven
malware-free. It records what was examined, what was changed, how the changes
were tested, and what risk remains.

## 1. Architecture (as found)

| Area | Implementation |
|---|---|
| Frontend | React 19 + Vite SPA (`src/`), Remotion player for preview, WebGL effects, onnxruntime-web models |
| Desktop shell | Electron 43. `desktop/bootstrap.ts` → `desktop/main.ts` (main process); preload `desktop/preload.ts` (contextBridge `window.openChatCutDesktop`) |
| Backend | Vite-style plugins (`server/plugins/*`, ~70 route groups) mounted either in the Vite dev server or, when packaged, in an embedded Node HTTP server inside the main process (`desktop/embedded-server.ts`, `127.0.0.1:5199` with port affinity) |
| Renderer ↔ main | ~30 `ipcMain.handle` channels (dialogs, project store, credentials, updates, native inference, directory watch, agent path import); all check `senderFrame.url` |
| Renderer ↔ backend | Same-origin HTTP. Writes gated by a request-shape check (loopback + Host + Origin + Sec-Fetch-Site); GETs mostly ungated |
| Agent | In-renderer tool loop (`src/agent/*`) over many LLM providers (AI SDK), plus Claude Code / Codex / Copilot CLI backends (`server/claude-code`, `server/codex`, `server/copilot`). Tools execute without approval by design |
| MCP | OpenChatCut is an MCP **server**: `/api/external-mcp/mcp` (Streamable HTTP, bearer token in `~/.openchatcut/mcp-token`). Browser-bound sessions forward editor tools to the renderer; offline sessions run a server-side subset |
| Process execution | ffmpeg/ffprobe (bundled), Remotion compositor + chrome-headless-shell (bundled), whisper.cpp (bundled), skill scripts (`/api/skills/<slug>/exec`), capcut-cli via `npx`, external agent CLIs, git (skill install), curl (model downloads), PowerShell (MCP client connect) |
| Media | Upload/import into a media library; path imports keep a pointer to the original file; FFmpeg probing, proxies, waveforms, frame grids; export via Remotion (headless Chrome) or in-browser WebCodecs |
| Network | Provider APIs through a key-injecting proxy (`/llm`, `/assemblyai`), `safePublicFetch` (SSRF-safe) for URL imports, GitHub (skills, update check), pinned model downloads, optional Cloudflare R2 sync, optional LAN mobile upload |
| Storage | `userData` (settings `.env.local`, project store JSON/SQLite, render bundle), `~/.openchatcut` (MCP token, skills, models) |
| Logs | stdout/stderr only; no crash reporter; no telemetry (the agent's "friction" log stays in localStorage) |
| Update | electron-updater from GitHub releases, user-initiated download/install on Windows/Linux |
| Packaging | electron-builder (NSIS, asar with unpacked native binaries), cross-target staging script, GitHub Actions release workflow with packaged smoke tests on real Windows |
| Tests | ~610 `*.verify.*` scripts wired into `npm test` |

Existing controls that were verified as correct and kept: context isolation;
`nodeIntegration:false`; IPC sender validation; navigation/popup guard with
external hand-off limited to http(s); export destinations as opaque grant IDs
from native dialogs; SSRF-safe fetch with DNS pinning; argv-array spawning;
SHA-256-pinned model and whisper downloads; symlink-safe skill installer;
path-safe upload names; loopback-only binding; 0600 token and keystore files;
key values never returned to the renderer.

## 2. Findings and fixes

Severity reflects impact in the desktop product before this change.

| # | Severity | Finding (before) | Fix |
|---|---|---|---|
| F1 | **Critical** | Any agent prompt injection (web page, transcript, skill text), external MCP client or renderer script could run arbitrary programs: `/api/skills/<slug>/exec` allowed `npx`/`npm`/`uvx`, `bash SKILL.md` (agent-writable), `node --import=data:…`, with no approval | Default-deny capability broker + native dialog; `PROCESS_EXECUTION` grant per exact command line; SKILL.md not executable; node preload flags blocked; realpath check on scripts; reviewable-length cap (`server/plugins/skill-exec.ts`) |
| F2 | **High** | Template (motion-graphic) code from projects, plugin URLs and the agent ran in the editor renderer behind a regex blocklist. Trivial escapes: bare `openChatCutDesktop`, `x['constr'+'uctor']`, DOM ref → `ownerDocument.defaultView`, `<iframe srcDoc>`, `dangerouslySetInnerHTML` handlers; later review: class component → React fiber | AST capability guard (`src/template-guard.ts`): identifier allowlist, denied keys incl. `_`-prefixed/fiber fields, runtime guard on computed keys; element filter (no script/iframe/object/…; markup must be inert; DOM refs only on `<canvas>`; no class/exotic components); React API reduced; CSP |
| F3 | **High** | No CSP; renderer not sandboxed; devtools available in production | CSP without inline/remote script (`desktop/content-security-policy.ts`); `sandbox:true` and related `webPreferences`; devtools disabled when packaged; global web-contents guards; default-deny permission handlers (`desktop/security-policy.ts`) |
| F4 | **High** | Embedded server trusted any request with loopback-looking headers: other local processes/OS users could drive every API (incl. F1) and fetch the MCP token; DNS-rebinding pages could read GET routes, including `/llm/*` with provider keys injected | Front-door gate: Host allowlist + per-launch HttpOnly SameSite=Strict session cookie on every request; MCP bearer and phone-upload hand-off pass through to their own checks (`desktop/embedded-request-gate.ts`) |
| F5 | **High** | Agent/MCP local file access unrestricted by default (`AGENT_IMPORT_ROOTS` empty = everything); `browse_local_media` listed the whole disk; symlink named `x.svg` imported any file | Default deny; access only to folders picked in the native picker; kind from the real target; UNC/device/ADS/reserved-name rejection (`server/local-path-import.ts`, `server/security/local-path-safety.ts`, `desktop/agent-folder-grant-ipc.ts`) |
| F6 | **High** | Stored API keys could be redirected to any host by changing a provider base URL / `PROXY_URL` (`/api/keys`) or via "Test connection" overrides that reuse stored keys | `CREDENTIALS` grant when an endpoint/host-deriving setting (incl. `R2_ACCOUNT_ID`) changes host or a test combines a new host with a stored key (`server/security/settings-guard.ts`) |
| F7 | Medium | External MCP clients could self-select `approvalMode:"auto"`, disabling confirmation cards | `MCP_TOOLS` grant, scoped to the token, remembered per session at most |
| F8 | Medium | CapCut export: agent-chosen `draftsDir` (write anywhere), `draftName` option injection, any absolute source path, full environment (keys) passed to `npx --yes capcut-cli` | Path validation; name sanitization; `PROCESS_EXECUTION` + `FILES_WRITE` grants; credential-free child env |
| F9 | Medium | Claude Code CLI argument injection via unvalidated `sessionId`/`model`, prompts starting with `-` | Token validation; prompt prefixing |
| F10 | Medium | Executable planting: 6 modules spawned `ffmpeg`/`ffprobe` from PATH; packaged builds honored `FFMPEG_PATH`, `FFMPEG_BIN`, `npm_config_platform`, `OPENCHATCUT_WHISPER_CLI`, `CC_BROWSER_EXECUTABLE`, `CC_REMOTION_BINARIES_DIR` | Bundled binaries only; packaged builds resolve them from their package directories and ignore overrides |
| F11 | Medium | Supply chain: 28 packages from a third-party npm mirror; adm-zip (symlink overwrite, DoS) and sharp/libheif advisories | Official registry; `adm-zip@0.6.1`, `sharp@0.35.4`; `npm audit` = 0 |
| F12 | Medium | In-app update would install upstream (unsigned, unhardened) releases over this build | Direct install disabled for unsigned builds (`openchatcut.directUpdates`) |
| F13 | Medium | Electron could be repurposed as a Node interpreter (`ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, `--inspect`); no asar integrity | Fuses: RunAsNode off, NODE_OPTIONS off, inspect off, asar-only + embedded integrity validation, cookie encryption |
| F14 | Low | MCP token written 0644 into shell rc / client configs; "Connect" wrote other apps' configs and a persistent user env var without confirmation | Owner-only writes; `SYSTEM_INTEGRATION` prompt (never remembered) |
| F15 | Low | LAN mobile-upload listener opened without explicit consent | `NETWORK_ACCESS` grant |
| F16 | Low | Upload names allowed `:` (NTFS streams), `CON`/`NUL`, trailing dots/spaces | Rejected |
| F17 | Low | `PROXY_URL` credentials echoed to the renderer | Redacted (`scheme://***@host`), round-trip safe |
| F18 | Low | Skill installs (third-party code) without confirmation | `SYSTEM_INTEGRATION` grant per repository |
| F19 | Low | Microphone/clipboard permissions auto-granted (Electron default); camera allowed | Microphone and clipboard-read prompt; camera and all other permissions denied |
| F20 | Info | Packages shipped Linux/macOS binaries and dependency source maps | Filtered |

An independent adversarial review of the hardening found F2's React-fiber
variant, the name-scoped MCP grant, dialog truncation, the permission check
handler, and `R2_ACCOUNT_ID`. All were fixed and covered by tests before the
final build.

## 3. Security logging

`server/security/audit-log.ts` appends JSON lines to
`%APPDATA%\OpenChatCut\logs\security-audit.log` (owner-only, 5 MB rotation):
`capability.granted/denied`, `process.exec/blocked`, `path.rejected`,
`navigation.blocked`, `permission.granted/denied`, `http.rejected`, `mcp.tool`.
Values are passed through credential redaction (API-key shapes, bearer tokens,
`key=`/`token=` pairs, long hex/base64, URL credentials) and home-path
scrubbing, which is tested.

## 4. Files changed

58 files, +3.4k/−0.3k lines, in five commits on this branch.

- **New security modules:** `server/security/{capabilities,audit-log,local-path-safety,settings-guard}.ts`,
  `desktop/{security-policy,content-security-policy,embedded-request-gate,capability-prompt,capability-dialog,agent-folder-grant-ipc}.ts`,
  `src/template-guard.ts`.
- **Hardened:** `desktop/{main,embedded-server,packaged-runtime,smoke-probe,update-service,prepare-target}.ts`,
  `src/template-host.ts`,
  `server/{local-path-import,media-binaries,media-dir,keystore}.ts`,
  `server/plugins/{skill-exec,skill-install,settings,mobile-upload,external-agent,claude-code-agent,isolate-voice,voice-media,sound,sonilo-media,music-media,video-media}.ts`,
  `server/external-agent/{mcp,jianying-export,client-connect}.ts`,
  `server/claude-code/turn-runner.ts`, `cli/main.ts`,
  `src/agent/tools/agent-path-import-tools.ts` (+ regenerated
  `assets/agent/openchatcut-tool-schemas.json`).
- **Build:** `config/electron-builder.config.mjs`, `config/vite.config.ts`,
  `package.json`, `package-lock.json`.
- **Tests:** new `server/security/security-core.verify.ts`,
  `server/security/privileged-boundaries.verify.ts`,
  `desktop/electron-security.verify.ts`,
  `src/template-host.security.verify.ts`. Updated to grant-based expectations:
  `desktop/agent-local-media.verify.ts`,
  `desktop/agent-path-import.e2e.verify.ts`,
  `src/agent/tools/agent-path-import-tools.verify.ts`,
  `server/plugins/mobile-upload.verify.ts`,
  `server/external-agent/offline-mcp*.verify.ts`.
- **Docs:** `security/*.md`.

## 5. Behavior changes users will notice

- The agent asks you to pick a folder the first time it needs local media
  (browse or import by path).
- Running skill scripts, installing skills, CapCut export, changing provider
  endpoints or storage folders, phone upload, "Connect" for MCP clients, and
  external-agent auto-approval show a permission dialog.
- In-app "download and install update" is replaced by the release page link
  in unsigned builds.
- Templates that relied on class components, React internals or DOM refs on
  non-canvas elements render those parts as nothing. All 235 bundled templates
  compile and render unchanged.

## 6. Remaining known risks

See THREAT_MODEL.md §3. In short:

1. Template code still runs in-process in the renderer (guarded, CSP-backed;
   not a VM boundary).
2. The agent's non-privileged actions (timeline edits, configured paid
   generation, public web fetch) run without per-call prompts by design.
3. API keys are stored in plaintext `.env.local` (owner-only). DPAPI/Credential
   Manager is a follow-up.
4. Unsigned binaries (no Authenticode); users must verify SHA-256 checksums.
5. Decoder attack surface (FFmpeg 6.1.1, Chromium 149, libvips) depends on
   upstream patching. ffmpeg-static and Chrome for Testing downloads have no
   upstream checksums (hashes are recorded instead).
6. Optional integrations resolve external CLIs from PATH (Claude Code, Codex,
   git) when the user enables them.
7. Phone upload is plaintext HTTP on the LAN while a session is open (after
   consent).
8. `'unsafe-eval'` remains in the CSP (template compilation, ajv,
   onnxruntime-web).
