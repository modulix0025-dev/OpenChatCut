# OpenChatCut permission model

OpenChatCut runs as the signed-in Windows user, never as Administrator, and
follows **least privilege + default deny + explicit capabilities**. Anything
that reaches beyond the app's own data — running a program, touching folders
you did not pick, redirecting your API keys, opening a network listener,
letting an external agent act without asking — goes through one central
authorization point and needs your explicit permission.

## Where the decision is made

`server/security/capabilities.ts` is the single capability broker. Privileged
code paths call `requireCapability({...})` immediately before acting; there is
no other way to perform those actions.

- **Desktop app:** the broker asks through a **native Windows dialog** drawn by
  the Electron main process (`desktop/capability-prompt.ts`). Page script — a
  compromised editor page, AI-agent output, a malicious template or project —
  cannot draw, pre-answer or click it.
- **No prompt available** (headless use, tests): **deny**.
- **Source checkout dev server** (`npm run dev`): an explicit development
  policy allows and logs each request; `OPENCHATCUT_CAPABILITY_POLICY=deny`
  makes it deny instead. The packaged app never uses this policy.
- **`occ` command line:** the command the user typed is the authorization; its
  privileged steps are allowed and audited.

Requests are serialized (one dialog at a time), and after a **Deny** the same
request is refused silently for 30 seconds so a looping agent cannot flood you
with dialogs.

## The dialog

```
OpenChatCut wants to: run a program from the skill "video-captions"

Permission: Run a program
Requested by: the AI agent

Command: node render.mjs --out out.mp4
Working folder: the "video-captions" skill folder
This runs with your user account's permissions.

Only allow this if you started the action and trust it.

 [ Deny ]  [ Allow once ]  [ Allow for this session ]  [ Allow for this project ]  [ Always allow ]
```

- **Deny** is the default button and what Esc / closing the dialog does.
- **Allow once** — this request only.
- **Allow for this session** — until OpenChatCut quits (memory only).
- **Allow for this project** — shown when the request belongs to a project;
  persisted, applies to that project only.
- **Always allow** — persisted in
  `%APPDATA%\OpenChatCut\security\capability-grants.json` (owner-only).
- Some requests are never rememberable (e.g. writing the MCP token into
  another application's configuration) and only offer Deny / Allow once.

Grants are **narrow**: they bind to the exact target (the exact command line of
one skill, one folder, one server host, one MCP client name), never to a whole
capability class. Deleting `capability-grants.json` revokes every persisted
grant.

## Capabilities

| Capability | What triggers a prompt | Scope of a remembered grant |
|---|---|---|
| `PROCESS_EXECUTION` | Running a skill script (`run_skill_script` / `/api/skills/<slug>/exec`); running `capcut-cli` for a CapCut/JianYing draft export | skill + exact command line; the exact capcut-cli command |
| `SYSTEM_INTEGRATION` | Installing a third-party skill from GitHub; writing the MCP token into another app's configuration ("Connect" in the MCP panel) | `owner/repo`; not rememberable |
| `FILES_READ` | The agent (or an external MCP client) needs a local folder that has not been granted → **native folder picker**; only what you pick is added | the folder you picked (`AGENT_IMPORT_ROOTS`) |
| `FILES_WRITE` | CapCut draft export into a non-default folder; moving the projects, media library or skills folder in Settings | the exact folder |
| `CREDENTIALS` | Changing a provider base URL / `PROXY_URL` to a different host while keys are stored; "Test connection" that would send a *stored* key to a new host | setting name + host |
| `NETWORK_ACCESS` | Starting a phone-upload session (opens a temporary listener on your local network) | session |
| `MCP_TOOLS` | An external MCP client asks for `approvalMode: "auto"` (no per-action confirmation) | the client's name |
| `MEDIA_CAPTURE` | The editor asks for the microphone (voice-over recording). Camera requests are always refused | microphone |
| `CLIPBOARD` | Page script tries to *read* the clipboard (writes of copied text are allowed) | clipboard read |
| `MEDIA_IMPORT` / `MEDIA_EXPORT` | Import and export use **native open/save dialogs** (the user picks the file/folder; the renderer only receives an opaque grant ID for export folders) | per dialog |

## What the app can access without asking

- Its own data: `%APPDATA%\OpenChatCut` (settings, projects database, logs,
  security state), the media library folder (default inside the app data
  folder or the location you chose), `%LOCALAPPDATA%` caches, and the
  `~\.openchatcut` folder (MCP token, skills, model cache).
- Files and folders **you** pick in native dialogs, or drag onto the window.
- Folders you previously granted to the agent (listed in Settings as the
  agent import roots).
- Temporary folders it creates itself (`mkdtemp`) for media processing.
- The bundled executables it ships (FFmpeg, FFprobe, the Remotion compositor,
  Chrome Headless Shell, whisper.cpp). Environment variables cannot redirect
  these in the packaged app.
- Outbound HTTPS to the AI / media providers **you configured**, GitHub (skill
  installs you approve, update check), and the pinned model downloads.
- `127.0.0.1` for its own embedded server. Only the OpenChatCut window (and
  external MCP clients holding the token) can talk to it.

## What the app explicitly cannot do without your authorization

- Read or list folders you have not picked (the agent's local-media access
  starts empty).
- Write outside its data folders, except to locations you chose in a dialog or
  granted through a prompt.
- Run any program other than its bundled media binaries, or any skill script.
- Install third-party code.
- Send your stored API keys to a server other than the one they were
  configured for.
- Change where your projects/media/skills are stored.
- Accept connections from your local network.
- Let an external agent act without per-action confirmation.
- Use your microphone or read your clipboard. It never uses your camera.
- Run elevated, install services, scheduled tasks, startup entries or
  drivers. None of these exist in the app.
- Replace itself with a downloaded update (disabled in unsigned builds).

## Operating-system permissions

| Item | Value |
|---|---|
| Execution level | `asInvoker`: standard user, no UAC prompt |
| Installer | Per-user by default (`%LOCALAPPDATA%\Programs\OpenChatCut`), no admin. A per-machine install is optional and is the only step that asks Windows for elevation |
| Services / drivers / scheduled tasks / Run keys | None |
| Firewall | No inbound listener by default (loopback only). Starting a phone-upload session opens a LAN listener; Windows may ask to allow it |
| Portable build | Extracts to a temporary folder and runs as the current user; stores data in `%APPDATA%\OpenChatCut` like the installed build |

## Audit log

Every capability decision, blocked navigation, refused path, rejected HTTP
request, process launch and MCP tool call is appended to
`%APPDATA%\OpenChatCut\logs\security-audit.log` (JSON lines, owner-only,
rotated at 5 MB). Records contain the capability, action, requester, decision
and target (command, folder, host). Credential-shaped values and home-folder
paths are redacted before writing (`server/security/audit-log.ts`), and file
contents are never logged.

## Telemetry

OpenChatCut sends **no telemetry**. The agent's `report_user_friction` tool,
described in the code as "silent product telemetry", only appends to a local
50-entry ring buffer in the editor's local storage and never leaves the
machine. The only automatic network request is the update check against
GitHub's releases API, which reveals your IP address to GitHub.
