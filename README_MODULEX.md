# OpenChatCut — ModuleX changes

This fork of [OpenChatCut](https://github.com/0xsline/OpenChatCut) (AGPL-3.0)
adds security hardening and the fixes listed in
[CHANGELOG_MODULEX.md](CHANGELOG_MODULEX.md). The upstream license and
copyright notices are unchanged; this fork is AGPL-3.0 too.

> **بالعربي باختصار:** حمّل الـ installer من صفحة الـ Releases، أو ابنِ
> النسخة بنفسك بتشغيل `BUILD_MODULEX.bat` على ويندوز (محتاج Node.js 24).
> إعدادات ComfyUI موجودة في «الإعدادات ← توليد بالذكاء الاصطناعي ← ComfyUI»،
> وشرح ملفات الـ manifest تحت في قسم ComfyUI.

## Download

Every successful run of the *Windows hardened build* workflow can be
published as a GitHub pre-release (workflow *Publish hardened release*). Each
release has the installer, the portable executable and `SHA256SUMS.txt`.
The executables are unsigned: SmartScreen warns on first run (More info →
Run anyway). See [security/CODE_SIGNING.md](security/CODE_SIGNING.md).

## Build on Windows

Requirements: Node.js 24 and Git.

```bat
git clone https://github.com/modulix0025-dev/OpenChatCut.git
cd OpenChatCut
BUILD_MODULEX.bat                 :: install, security tests, installer + portable
BUILD_MODULEX.bat --full-tests    :: also run the whole test suite first
```

The script runs these package.json commands, which you can also run by hand:

| Step | Command |
|---|---|
| Install | `npm ci` |
| Security regression tests | `npm run verify:security` |
| Whole test suite | `npm test` |
| Installer + portable exe | `npm run desktop:dist:win:all` (output in `release\`) |
| Installer only | `npm run desktop:dist:win` |
| Run from source | `npm run desktop:dev` |

The same build runs on a clean Windows machine in GitHub Actions
(`.github/workflows/windows-hardened.yml`): it also installs the app, runs
the packaged smoke test (security boundaries, app log, a real render) and
uninstalls it.

Updates: in-app self-update is off in these unsigned builds, so an upstream
release can never replace the fixes. Install a newer release over the old
one; user data is kept.

## Where things are

| What | Where |
|---|---|
| Application log | `%APPDATA%\openchatcut\logs\app.log` (Settings → *Open logs folder*) |
| Security audit log | `%APPDATA%\openchatcut\logs\security-audit.log` |
| Projects (default) | `%USERPROFILE%\.openchatcut\project-store-v1` |
| Storage folder pointer | `%USERPROFILE%\.openchatcut\data-dir.json` |
| Result of the last storage move | `%USERPROFILE%\.openchatcut\last-relocation.json` |

## ComfyUI

Settings → AI generation → Image (or Video) → **ComfyUI**:

- **ComfyUI address**: `http://127.0.0.1:8188` for a local ComfyUI, or the
  tunnel address of a rented GPU server.
- **Access token** (optional): sent as `Authorization: Bearer …` for a
  protected tunnel.
- **Workflow folder**: a folder of workflow pairs.

Each workflow is two files with the same name:

1. `<id>.json`: the workflow exported from ComfyUI with **Save (API Format)**
   (enable dev mode options in ComfyUI's settings to see it). A normal UI
   export (with `nodes` and `links`) is rejected with a clear message.
2. `<id>.manifest.json`: which node inputs receive the values, and which
   node's output is the result.

```json
{
  "name": "Flux portrait",
  "kind": "image",
  "inputs": {
    "prompt":         { "node": "6",  "field": "text" },
    "negativePrompt": { "node": "7",  "field": "text" },
    "seed":           { "node": "3",  "field": "seed" },
    "width":          { "node": "5",  "field": "width" },
    "height":         { "node": "5",  "field": "height" },
    "image":          { "node": "10", "field": "image" }
  },
  "output": { "node": "9" }
}
```

- `kind` is `image` or `video`. Only `prompt` and `output` are required.
- Video workflows can also map `frames` (the length in frames, computed from
  the requested seconds × fps) and `fps`.
- `image` receives a reference image, uploaded to ComfyUI first. Map it to a
  `LoadImage` node.
- Node ids are the keys of the API-format JSON. Field names are the input
  names shown in that JSON.
- Examples: [examples/comfyui/](examples/comfyui/). The image example matches
  ComfyUI's default text-to-image graph.

The agent uses ComfyUI through `submit_image` / `submit_video` with
`model: "comfyui"` and `workflow: "<id or name>"`. If the workflow is
unknown, the result lists the available ones. Video runs are generation jobs
that survive an app restart. Generated videos have the embedded workflow
metadata removed before they enter the media pool.

A ComfyUI result referenced by URL in a project (for example
`http://127.0.0.1:8188/view?…`) is downloaded at export time after you allow
that address in the permission dialog.

## Other settings added here

| Setting | Where | Default |
|---|---|---|
| Extra Claude Code models | Agent → Anthropic · Claude Code → *Extra models* | none; the list comes from the model catalog, plus Opus 5.5 and Fable 5.1 |
| Claude Code turn timeout | same page → *Turn timeout (seconds)* | 6000 s (60–7200) |
| Imported files | Storage → *Imported files* | copy into the project library (`MEDIA_IMPORT_MODE=link` keeps files in place) |
| Orphaned external edit sessions | browser localStorage `EXTERNAL_SESSION_ORPHAN_MINUTES` | 5 minutes |

## Extension points

Each extension point is one place with a clear contract, and each has a
test that fails if the pieces disagree.

### Add a Remotion component to the motion-graphics sandbox

1. Add its name to `TEMPLATE_GLOBAL_NAMES` in `src/template-api.ts`. That
   list is also what the motion-graphics generator prompt advertises.
2. Import and inject it in `src/template-host.ts` (`WHITELIST`). If it is a
   `forwardRef` or `memo` object, add it to `TRUSTED_COMPONENT_OBJECTS` too.
3. `npm run verify:security` checks that the two lists match and that an
   `AbsoluteFill` scene renders. Anything the sandbox refuses shows a visible
   *Template error* label instead of rendering blank.

### Add a Claude model

Nothing to code: a catalog refresh (`scripts/update-llm-model-capabilities.mjs`
→ `assets/model-capabilities/models-dev.json`) brings new Anthropic models
into the list, and users can add any id under *Extra models*. Models released
after the bundled catalog snapshot go in `MODELS_NEWER_THAN_CATALOG`
(`server/claude-code/models.ts`). Test: `server/claude-code/models.verify.ts`.

### Add a generation provider

ComfyUI is the worked example:

- Client and protocol: `server/plugins/comfyui-client.ts`. Provider glue:
  `server/plugins/comfyui-provider.ts`.
- Images (synchronous): add the model to `ValidImageRequest` and
  `validateImageRequest`, then add a dispatch branch in
  `server/plugins/image.ts` that returns `ProviderImage[]`.
- Video (resumable job): add the model to `server/plugins/video-validation.ts`,
  add a branch in `runVideoOperation` (`server/plugins/video.ts`) that submits,
  calls `registerProviderTask` and polls, and add it to the resumer list.
- Settings: add the keys to `server/keystore-names.ts`, the "configured"
  check to `computeCaps` in `server/keystore.ts`, and a vendor page in
  `src/components/settings/settingsSchema.ts`.
- Agent: add the tool schema enum in `src/agent/tools/generate-schemas.ts`,
  the argument builder in `src/agent/tools/generate-tool-input.ts`, and the
  provider row in `CAP_PROVIDERS` (`src/agent/capabilities.ts`). Then run
  `npm run generate:server-tool-catalog`; the build checks the catalog is
  current.
- Test with a fake HTTP API: `server/plugins/comfyui.verify.ts`.

### Add an MCP / agent tool

1. Schema: a file in `src/agent/tools/schemas/` (or an existing one).
2. Handler: `src/agent/tools/<area>-tools.ts`.
3. Registration: the tool map in `src/agent/tools.ts`.
4. Run `npm run generate:server-tool-catalog` (the prebuild step checks it).

Tests: the tool's own `*.verify.ts`, plus `src/agent/tool-activation.verify.ts`.
External MCP clients get the same tools through
`server/external-agent/mcp.ts`.

### Add a UI language

Dictionaries live in `src/i18n/dict/<locale>/`. The key is the Chinese
source text and the value is the translation.

1. Add the locale to `Locale` / `ALL_LOCALES` in `src/i18n/locale.ts` (and to
   `RTL_LOCALES` for right-to-left scripts).
2. Add a loader in `src/i18n/dictRegistry.ts`, with English as the fallback.
3. Run `npm run verify:i18n`.

Arabic (`ar`) is the worked example.

## Tests

- `npm test` runs every `*.verify.*` file (about 620).
- `node scripts/verify-registration.verify.mjs` fails if a new verify file
  is not registered in package.json.
- `node scripts/verify-gate-coverage.verify.mjs` enforces the 500-line cap
  per source file.
