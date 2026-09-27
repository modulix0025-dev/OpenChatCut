# ModuleX changelog

Base: upstream OpenChatCut 0.2.14 (`404da7c`), plus the security hardening
described in [security/SECURITY_AUDIT.md](security/SECURITY_AUDIT.md). Each
entry: problem, cause, change, test. Numbers follow the issue list the fixes
were requested from.

## F1 / F2: blank motion-graphics scenes

- **Problem:** scenes rendered blank with no error, including everything the
  built-in generator writes.
- **Cause:** a regression introduced by this fork's own sandbox hardening. It
  refused every object element type, and Remotion's `AbsoluteFill`,
  `Sequence`, `Video`, `Audio` and `Img` are `forwardRef` objects.
- **Change:** Remotion components are trusted by reference. `React.memo`
  around a function component and context objects are allowed. Refused
  components render a visible *Template error* label. `OffthreadVideo`,
  `Series`, `Loop` and `Freeze` are added. The generator prompt and the
  sandbox share one list (`src/template-api.ts`).
- **Test:** `src/template-host.security.verify.ts` renders an
  `AbsoluteFill`-rooted scene and checks the lists match.

## F3: Windows export fails at the audio step

- **Problem:** `Error selecting an encoder … audio.aac`.
- **Cause:** Windows mirrors ffmpeg-static into `remotion-binaries-<ver>` for
  hardware encoders, and that build lacks the `libfdk_aac` encoder that
  Remotion requests.
- **Change:** when the ffmpeg in use lacks `libfdk_aac`, H.264 renders take MP3
  audio and remux it to AAC with ffmpeg's built-in encoder; ProRes takes PCM.
  Hardware encoding is kept.
- **Test:** `remotion/direct-hardware.verify.mjs`.

## F4: audio added by a local URL stops the export

- **Problem:** "non-standard URL ports are not allowed".
- **Change:** the app's own `http://127.0.0.1:<port>/media/uploads/…` URLs
  render as local files. Other loopback services (ComfyUI) are downloaded
  after the user allows that address in the permission dialog. LAN addresses
  stay refused.
- **Test:** `server/loopback-media.verify.ts`.

## F5: `add_audio` lands elsewhere and is cut short

- **Cause:** the reducer silently moved the clip to the nearest free gap, and
  a just-imported pool entry could carry a placeholder duration.
- **Change:** an occupied frame is refused with the blocking clips and
  suggestions. Project audio takes its real length from ffprobe. The result
  reports where the clip landed.
- **Test:** `src/agent/tools/audio-assets.verify.ts`.

## F6: external (MCP) sessions break after every change

- **Cause:** a user edit advanced the revision, and the next status call
  poisoned the whole MCP session. Stale drafts blocked `begin_edit_session`
  with "already active".
- **Change:** status and project tools follow the same editor to its current
  revision; a different editor instance is still a takeover. A stale edit
  call fails alone, and the connection rebinds. Drafts that are stale against
  the project, or idle for 5 minutes, give way to a new session. The chat
  panel shows which tool holds the project, with a *Release* button.
- **Test:** `server/external-agent/mcp.verify.ts`,
  `src/agent/external-edit-session-runtime.verify.ts`.

## F7: project "disappeared" after changing the storage folder

- **Cause:** the move copied projects when the setting was saved; the app
  kept writing to the old folder, and the next launch opened the old copy. A
  destination with data was skipped silently.
- **Change:** the move is recorded as pending and performed at the next
  launch, before the project store opens, with the latest data. A folder with
  existing projects needs an explicit choice: replace (the old data is kept
  as a backup) or use it. A failed move keeps the current data and is
  reported. Cloud-synced folders get a warning.
- **Test:** `server/data-dir-relocation.verify.ts`.

## F8: random Chinese project names

- **Change:** new projects are named `New project <date, time>` in the
  interface language. The `edit_project` description says it renames the
  project itself.
- **Test:** `src/persist/defaultProjectName.verify.ts`.

## F9: ComfyUI videos vanish after import (the main issue)

- **Cause:** import probes kept only the last 1,000,000 characters of
  ffprobe's JSON. ComfyUI embeds about 2 MB of workflow metadata, so parsing
  failed and the clip was removed, with the error visible only in devtools.
- **Change:** probes request only the fields they use (no tags). Output is
  collected whole up to 64 MB, with an explicit error past that. This applies
  to media normalization, local import, watched folders and `probe_media`.
  Failed imports name the file and the reason, and stay listed with *Retry*.
- **Test:** `server/process-output.verify.ts` fails on the old code with the
  same JSON error.

## F10: no log

- **Change:** `%APPDATA%\openchatcut\logs\app.log`, rotated at 5 MB. It holds
  main-process, server and renderer messages, crashes, and every failed
  ffmpeg/ffprobe run with its stderr. Settings has *Open logs folder*.
  Devtools stay off.
- **Test:** `desktop/app-log.verify.ts`; the packaged smoke test checks that
  the log is written.

## F11: ComfyUI generation

- **Change:** a new ComfyUI provider for images and video, driven by the
  user's API-format workflows plus a manifest. Video runs are resumable jobs,
  and generated videos have their metadata stripped. See
  [README_MODULEX.md](README_MODULEX.md#comfyui).
- **Test:** `server/plugins/comfyui.verify.ts`.

## F12: no Opus 5.5

- **Change:** the Claude Code model list is built from the catalog, plus
  models newer than the snapshot (`claude-opus-5-5`, `claude-fable-5-1`), plus
  the *Extra models* setting.
- **Note:** the bundled `models-dev.json` did not contain `claude-opus-5-5`,
  contrary to the issue report.
- **Test:** `server/claude-code/models.verify.ts`.

## F13: 600-second spin, then a refusal

- **Change:** a denied tool is reported in the chat immediately with its
  reason. Failed tools show the CLI's reason instead of a generic message.
  After 90 s without progress, the chat says what the turn is waiting on. The
  turn limit is a setting.
- **Not done:** a new in-chat approval card. Privileged actions already use
  the native permission dialog (allow once, session, project or always, or
  deny), and the waiting notice points to it.
- **Test:** `server/claude-code/claude-code-agent.verify.ts`,
  `server/agent-runs/claude-code-turn.verify.ts`.

## F14: imported files tied to their original location

- **Change:** imports are copied into the project library by default
  (copy-on-write where supported). *Imported files → Link* keeps the old
  behavior. Moved linked files show as offline with *Relink*, as before.
- **Test:** `desktop/local-media-import.verify.ts`.

## F15: half-written render bundle

- **Change:** `remotion-bundle-<ver>` is checked on every launch against the
  shipped bundle (file list, sizes and a completion marker) and recreated if
  anything differs. Deleting a bundle first unlinks its `media/uploads`
  junction, so the user's media is never touched.
- **Test:** `desktop/packaged-runtime.verify.ts`.

## F16: Chinese messages in a non-Chinese interface; Arabic

- **Change:** Chinese error messages that reached the UI go through `t()`
  (browser) or are English (server). Russian now falls back to English
  instead of the Chinese key. Arabic is added as a full language, with a
  right-to-left layout; the timeline, preview and scopes stay left to right.
- **Test:** `npm run verify:i18n`.

## Also fixed along the way

- **Windows builds failed at prebuild.** `sync-shader-sources` wrote
  backslash paths into generated headers, so every committed file looked
  stale on Windows.
- **Cross-built Windows packages had no local ASR binary.**
- **The render bundle copy could not recover** from a copy interrupted after
  `index.html` (F15).
