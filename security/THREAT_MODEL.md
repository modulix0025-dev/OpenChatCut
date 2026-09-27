# OpenChatCut desktop — threat model

Scope: the packaged Windows desktop application (Electron 43, `desktop/`), the
embedded server it runs (`server/`, mounted by `desktop/embedded-server.ts`),
the editor renderer (`src/`), the in-app AI agent, and the external MCP
endpoint. Status reflects the code at the commit that adds this file.

## 1. Architecture and trust boundaries

```
 ┌──────────────── OpenChatCut.exe (Electron main process, user privileges) ───────────────┐
 │  desktop/main.ts ── capability broker (native dialog) ── audit log (userData/logs)       │
 │        │                                                                                │
 │        ├─ IPC (preload contextBridge, sender-validated) ◄──── Renderer (sandboxed)       │
 │        │                                                   editor UI + AI agent loop    │
 │        │                                                   + template code (guarded)   │
 │        └─ embedded HTTP server 127.0.0.1:5199 ◄── session cookie ── Renderer           │
 │              │  server/plugins/* (media, export, keys, skills, MCP, agent runs)         │
 │              ├─ /api/external-mcp/mcp ◄── Bearer token ── external MCP clients          │
 │              ├─ child processes: ffmpeg/ffprobe (bundled), Remotion compositor,        │
 │              │   chrome-headless-shell (bundled), whisper (bundled), skill scripts*,    │
 │              │   capcut-cli*, Claude Code / Codex / Copilot CLIs (user-installed)       │
 │              └─ outbound HTTPS: AI/media providers the user configured, GitHub (skills,  │
 │                 update check), HuggingFace/model mirrors (pinned model downloads)      │
 │  utilityProcess workers (ASR, semantic, CLAP, rhythm) — bundled .mjs, no network input │
 └────────────────────────────────────────────────────────────────────────────────────────┘
   * requires an explicit PROCESS_EXECUTION grant
 Optional: mobile-upload listener on the LAN (0.0.0.0, token URL, 10-minute session,
 requires a NETWORK_ACCESS grant).
```

Trust levels:

| Actor / input | Trust | Reaches |
|---|---|---|
| The signed-in Windows user | Trusted | Native dialogs, settings |
| Main process code | Trusted | Everything the user can |
| Renderer (editor UI) | **Semi-trusted** — runs untrusted content (templates, markdown, provider media) | IPC (typed, sender-checked), embedded HTTP API (cookie) |
| AI agent output / tool calls | **Untrusted** (prompt injection via web pages, transcripts, media metadata, skills) | Editor tools; privileged actions only via the broker |
| External MCP client (holds bearer token) | **Untrusted** | Editor tools through the MCP bridge; auto-approval only via the broker |
| Project files, imported templates/plugins, media files & metadata | **Untrusted** | Parsed by the renderer/server; template code only through the guard |
| Other local processes / OS users | **Untrusted** | Nothing (Host allowlist + session cookie), except the MCP endpoint with a token |
| Web pages in the user's browser | **Untrusted** | Nothing (DNS rebinding and CSRF refused at the front door) |

## 2. Risk register — traced to code

Legend: **Mitigated** (fixed/controlled in this change), **Pre-existing control**
(was already correct; verified), **Residual** (accepted/documented risk).

| # | Threat | Where it exists in this codebase | Status |
|---|---|---|---|
| 1 | Malicious media file | ffmpeg/ffprobe/Remotion/Chromium decoders parse attacker bytes (`server/media-*`, `server/plugins/probe-media.ts`). Inputs are always absolute local paths or verified uploads; no protocol URLs reach ffmpeg; remote media is downloaded via `safePublicFetch` first. | Pre-existing control; **Residual**: decoder memory-safety bugs (FFmpeg 6.1.1 static build, Chromium 149) are outside app control — keep dependencies updated. |
| 2 | Malicious project file | Project JSON is loaded by the renderer. MG/template items carry **JS code** executed on project open (`src/editor/TimelineReadinessGate.tsx`). Old regex sandbox was escapable (`x['constr'+'uctor']`, bare `openChatCutDesktop`, DOM refs → `ownerDocument.defaultView`, `<iframe srcDoc>`, `dangerouslySetInnerHTML` handlers). | **Mitigated**: `src/template-guard.ts` AST capability guard + runtime key guard + element/markup filter (`src/template-host.ts`) + production CSP. 30 escape payloads in `src/template-host.security.verify.ts`. **Residual**: not a VM boundary (see §3). |
| 3 | Malicious imported assets / plugin packs | `src/plugins/install.ts` installs template packs from URLs → same template path. Skill packs from GitHub contain scripts. | **Mitigated**: templates via the guard; skill install needs `SYSTEM_INTEGRATION` grant; every script run needs `PROCESS_EXECUTION` grant. |
| 4 | Path traversal | Upload names (`server/media-dir.ts isSafeUploadName`), dist static (`desktop/static-files.ts`), skill slugs, export file names. | Pre-existing control (verified). **Mitigated**: Windows-specific gaps (ADS `:`, `CON`/`NUL`, trailing dot/space) in upload names. |
| 5 | Arbitrary file read | Agent/MCP `browse_local_media` and `import_*` accepted **any** absolute path when `AGENT_IMPORT_ROOTS` was empty (the default); CapCut export read any existing absolute clip path; a symlink named `x.svg` imported arbitrary files. | **Mitigated**: default deny until the user picks a folder in the native picker; realpath containment; kind from the real file name; UNC/device/ADS rejection (`server/security/local-path-safety.ts`). |
| 6 | Arbitrary file write | CapCut export wrote to any agent-chosen `draftsDir`; settings could relocate data/media/skills dirs; export overwrite into user-chosen dir. | **Mitigated**: CapCut dir + data/media/skills relocation need `FILES_WRITE` grants; exports only into dirs chosen in the native save/open dialog (pre-existing grant IDs). **Residual**: an export into a user-chosen folder may overwrite an existing file of the chosen name (by design, OS dialog confirms). |
| 7 | Arbitrary command execution | `/api/skills/<slug>/exec` allowed `npx`, `npm`, `uvx`, `bash SKILL.md`, `node --import=data:…` with **no approval**; reachable from agent prompt injection and renderer JS. | **Mitigated**: every distinct command line needs a `PROCESS_EXECUTION` grant (native dialog shows the exact command); SKILL.md never executable; node preload flags blocked; symlinked scripts refused. |
| 8 | Shell / command injection | All spawns use argv arrays (`execFile`/`spawn` without `shell`), verified by audit. Windows `.cmd` shims for Claude/Codex CLIs go through `cmd.exe` with caret escaping (`server/claude-code/command.ts`). | Pre-existing control. **Residual**: `.cmd` shim quoting relies on that escaper (prompt text is passed as an argument). |
| 9 | Argument injection | `sessionId`/`model` passed after `--resume`/`--model` to Claude CLI unvalidated; prompt starting with `-`; capcut-cli `draftName` starting with `-`. | **Mitigated** (`server/plugins/claude-code-agent.ts cliToken`, `turn-runner.ts`, `jianying-export.ts`). |
| 10 | Unsafe IPC | 30+ `ipcMain.handle` channels. | Pre-existing control: every handler validates `senderFrame.url` origin (enforced by `desktop/electron-security.verify.ts`); inputs are schema-checked. |
| 11 | Renderer compromise | Any XSS / template escape previously gave: shell (skill exec), key redirection (`/api/keys`), whole-disk import. | **Mitigated**: all of those now require a native-dialog grant the renderer cannot click; CSP forbids inline/remote script; renderer is sandboxed. |
| 12 | Preload compromise | `desktop/preload.ts` exposes one typed API; bundles only `electron`. | **Mitigated**: `sandbox: true` (preload has no Node APIs); no raw `ipcRenderer` exposure (verified by test). |
| 13 | Node.js API exposure | `nodeIntegration` was false; `sandbox` unset. | **Mitigated**: `sandbox`, `contextIsolation`, no node in workers/subframes, `webviewTag:false`; fuses disable `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, `--inspect`. |
| 14 | Remote content execution | Renderer loads only the embedded origin; navigation guard sends http(s) to the system browser, denies other schemes. | Pre-existing control + **Mitigated**: CSP `script-src 'self'`, global `web-contents-created` guards, webview attach refused. |
| 15 | XSS | React escaping; markdown via `react-markdown` (no raw HTML). Template `dangerouslySetInnerHTML` was open. | **Mitigated**: markup filter + CSP. |
| 16 | Prototype pollution | Template code could reach `Object.prototype` via `__proto__`/`constructor`. JSON project parsing uses `JSON.parse` (no merge-into-prototype utilities on untrusted keys found). | **Mitigated** for templates (denied keys + runtime guard). |
| 17 | Dependency vulnerabilities | `npm audit`: 3 high, 1 moderate (adm-zip symlink write + DoS, sharp/libheif). | **Mitigated**: overrides `adm-zip@0.6.1`, `sharp@0.35.4` → `npm audit`: 0. See DEPENDENCY_REPORT.md. |
| 18 | Compromised npm packages | 28 lockfile entries resolved from `registry.npmmirror.com`; 8 packages with install scripts; runtime `npx --yes capcut-cli`. | **Mitigated**: lockfile repointed to registry.npmjs.org (integrity hashes unchanged); cross-build packages verified against lockfile integrity; capcut-cli run needs a grant. **Residual**: install scripts of ffmpeg-static/esbuild/koffi/onnxruntime run at build time. |
| 19 | Malicious MCP servers/tools | OpenChatCut is an MCP *server*; it does not load third-party MCP servers. External MCP clients chose `approvalMode:'auto'` themselves, disabling the confirmation card. | **Mitigated**: auto-approval requires an `MCP_TOOLS` grant per client. |
| 20 | Malicious agent instructions / prompt injection | Built-in agent executes tools directly (no approval gate by design). | **Mitigated** for privileged actions (broker). **Residual**: non-privileged editor edits (timeline changes, paid generation with configured keys, web fetch through `safePublicFetch`) still run without per-call prompts; undo/versions exist. |
| 21 | Untrusted project metadata | Names/paths shown in UI (React-escaped); paths re-validated server-side. | Pre-existing control. |
| 22 | Unsafe URLs | `shell.openExternal` only for credential-free http(s); `javascript:`, `file:`, `data:`, `ms-*`/`search-ms:` denied (tested). | Pre-existing control (+ tests). |
| 23 | SSRF | `safePublicFetch` blocks private/loopback/link-local/metadata, pins DNS, re-checks redirects. `/api/keys/test` sent the stored key to any override URL with plain `fetch`. | **Mitigated**: override endpoint + stored key requires a `CREDENTIALS` grant. **Residual**: provider base URLs the user sets intentionally are fetched with plain `fetch` (user choice). |
| 24 | Unsafe redirects | `safePublicFetch` re-validates each hop (max 5). | Pre-existing control. |
| 25 | Credential / API-key leakage | Keys live in the main process only; `/api/keys` returns booleans. Redirection via base-URL/proxy edits; `PROXY_URL` echoed with credentials; capcut-cli got the full environment; MCP token written 0644 into shell rc/client configs. | **Mitigated**: `CREDENTIALS` grants for endpoint changes; proxy credentials redacted; child env scrubbed; token files written 0600. **Residual**: keys stored in plaintext `userData/.env.local` (0600; NTFS ACL = user profile). |
| 26 | Environment-variable leakage | Binary overrides (`FFMPEG_PATH`, `FFMPEG_BIN`, `OPENCHATCUT_WHISPER_CLI`, `CC_BROWSER_EXECUTABLE`, …) were honored in packaged builds. | **Mitigated**: packaged builds ignore them (executable allowlisting). |
| 27 | Insecure temp directories | All temp use is `mkdtemp`/UUID names (verified). | Pre-existing control. |
| 28 | Symlink attacks | Directory scans skip symlinks; skill install rejects symlinks (`O_NOFOLLOW`); realpath containment for grants. | Pre-existing + **Mitigated** (symlink kind spoof, skill-script realpath). **Residual**: TOCTOU between realpath check and open for user-granted folders. |
| 29 | Junction / reparse-point attacks | `realpath` resolves junctions on Windows; containment re-checked on the resolved path. | Mitigated by the same realpath containment. |
| 30 | DLL search-order / planting | Bundled executables live in `resources\app.asar.unpacked` inside the per-user install dir; whisper DLLs ship beside `whisper-cli.exe`. | **Residual**: an attacker able to write the user's own install directory already has the user's privileges. Per-machine installs place it under Program Files. |
| 31 | Executable planting | PATH lookups for `ffmpeg`/`ffprobe` in 6 modules. | **Mitigated**: bundled binaries only. **Residual**: optional integrations resolve user-installed CLIs from PATH (Claude Code, Codex, git for skill install). |
| 32 | Unsafe `child_process` usage | See §3 of SECURITY_AUDIT.md (full call-site table). | Mitigated as above. |
| 33 | FFmpeg command injection | Only numeric/allowlisted values reach filter strings; drawtext escaped; inputs are absolute paths. | Pre-existing control (verified). |
| 34 | Arbitrary executable invocation | Only allowlisted binaries; skill exec whitelist + grant. | **Mitigated**. |
| 35 | Privilege escalation | App requests `asInvoker`; installer is per-user by default. | **Mitigated** (no elevation). |
| 36 | Persistence mechanisms | No Run keys, scheduled tasks, services or login items are created by the app (searched). NSIS creates Start-menu/desktop shortcuts only. | Verified — none. |
| 37 | Startup / Task Scheduler abuse | None present. | Verified — none. |
| 38 | Insecure auto-update | `electron-updater` from GitHub releases; unsigned builds have no publisher verification. | **Mitigated**: in-app download-and-install disabled for this unsigned build (`package.json openchatcut.directUpdates=false`); users update via the release page. |
| 39 | Insecure IPC authorization | See #10. | Pre-existing control. |
| 40 | Excessive filesystem permissions | Agent had whole-disk read. | **Mitigated** (#5). |
| 41 | Sensitive-data exposure | Error bodies scrubbed of home paths (`server/error-scrub.ts`). | Pre-existing control. |
| 42 | Log leakage | Logs go to stdout; new security audit log is redacted (tested). | **Mitigated** (redaction). |
| 43 | Crash-report leakage | No crash reporter configured (no `crashReporter.start`). | Verified — none. |
| 44 | Insecure local HTTP server | Loopback-only, but no Host check on GET routes (DNS rebinding could read `/llm/*` with keys injected, `/api/skills`, account status) and any local process could forge Origin/Sec-Fetch-Site. | **Mitigated**: Host allowlist + per-launch HttpOnly session cookie on every request. |
| 45 | Insecure WebSocket servers | None. | Verified — none. |
| 46 | Exposed development ports | Dev server only in `npm run dev`; `CC_DESKTOP_DEV_URL` ignored when packaged. | Pre-existing control. |
| 47 | Debug endpoints | No `--remote-debugging-port`/`--inspect`; smoke hooks exit the app. | **Mitigated**: fuses block inspect flags; devtools disabled when packaged. |
| 48 | Developer tooling shipped | Source maps, other-OS binaries and dev CLIs. | **Mitigated**: `.map` excluded; foreign-platform binaries filtered. **Residual**: `@remotion/bundler`/webpack/rspack JS ship as production deps (needed by upstream code paths). |
| 49 | Local LAN exposure | Mobile upload listener on 0.0.0.0 over HTTP. | **Mitigated**: needs a `NETWORK_ACCESS` grant; 10-minute session, token URL. **Residual**: plaintext on the LAN while open. |
| 50 | Local whisper-server | Spawned on a random loopback port without auth while transcribing. | **Residual** (local-only, short-lived, no secrets). |

## 3. Residual risks that deserve attention

1. **Template code still runs in the editor renderer.** The guard is an
   allowlist over the AST plus runtime key checks, backed by a CSP and by the
   fact that every privileged action now needs a native-dialog grant. It is
   still in-process JavaScript with `'unsafe-eval'` enabled; a guard bypass
   would give script in the editor origin (limited to what the renderer can do
   without grants: edit projects, read what the page shows, send editor tool
   calls). The durable fix is evaluating templates in a sandboxed iframe or a
   QuickJS realm.
2. **The agent can still take non-privileged actions without asking** (edit
   the timeline, call configured paid generation providers, fetch public web
   pages). That is the product's design; undo and project versions are the
   recovery path.
3. **Plaintext API keys at rest** in `%APPDATA%\OpenChatCut\.env.local`
   (owner-only). Moving them to Windows Credential Manager/DPAPI
   (`safeStorage`) is a follow-up.
4. **Unsigned binaries.** Without Authenticode, SmartScreen warns and users
   cannot verify the publisher. See CODE_SIGNING.md.
5. **Optional integrations resolve external CLIs from PATH** (Claude Code,
   Codex, git). They run only when the user enables that backend.
