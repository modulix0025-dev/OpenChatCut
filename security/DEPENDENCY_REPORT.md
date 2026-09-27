# Dependency and supply-chain report

Package manager: npm 11 (Node 24.21.0). Lockfile: `package-lock.json`
(lockfileVersion 3). 711 production and 261 development packages. A CycloneDX
1.6 SBOM of the production graph (535 components) is published with each
release as `openchatcut-sbom.cdx.json`. Regenerate it with:

```
npx @cyclonedx/cyclonedx-npm@4 --omit dev --output-format JSON --output-file openchatcut-sbom.cdx.json
```

## Known vulnerabilities (`npm audit`)

| Package | Advisory | Severity | Path | Action |
|---|---|---|---|---|
| adm-zip ≤0.6.0 | GHSA-vwc7-r8mq-g2x9: extraction follows destination symlinks → arbitrary file overwrite | High | onnxruntime-node install script | **Fixed**: override → `0.6.1` |
| adm-zip <0.6.1 | GHSA-7q85-xj36-vmfc: uncontrolled allocation from declared size (DoS) | High | same | **Fixed**: `0.6.1` |
| sharp <0.35.4 | GHSA-rgj7-g3m4-5g8c: libheif vulnerabilities (GHSA-g89c-p67h-r497, GHSA-2jg2-4ch7-h545) | High | @huggingface/transformers | **Fixed**: override → `0.35.4` |
| onnxruntime-node 1.22.0 | via adm-zip | Moderate | direct | **Fixed** transitively; version stays pinned (the repo deliberately pins ORT 1.22.0, see `shared/onnxruntime-version.verify.ts`) |

Result after the fix: **`npm audit` → found 0 vulnerabilities** (production and
development).

`npm audit` only covers advisories published for npm packages. The native
binaries listed below have their own upstream CVE streams (FFmpeg, Chromium,
libvips/libheif, ONNX Runtime) and must be tracked separately.

## Registry integrity

- **Fixed:** 28 lockfile entries (the `@aws-sdk/*` / `@smithy/*` family)
  resolved from `https://registry.npmmirror.com/`, a third-party mirror, instead
  of the official registry. They now resolve from `https://registry.npmjs.org/`.
  The `integrity` (SHA-512) values are unchanged, and `npm ci` verified every
  tarball against them.
- All 972 `resolved` URLs now point to `registry.npmjs.org`.
- Cross-build packages that npm does not install on a Linux host (the Windows
  native bindings) are fetched by `desktop/prepare-target.mts` at the
  lockfile-pinned version. Each tarball is **verified against the lockfile's
  integrity hash** before it is unpacked.

## Install-time scripts (run on the build machine during `npm ci`)

| Package | Script | Purpose / risk |
|---|---|---|
| esbuild 0.28.1 | `postinstall: node install.js` | Verifies its platform binary. Well known. |
| ffmpeg-static 5.3.0 | `install: node install.js` | Downloads the FFmpeg binary from GitHub releases (`eugeneware/ffmpeg-static` b6.1.1) **without a checksum**. The build records the SHA-256 of the Windows `ffmpeg.exe` it ships (see the release verification report). |
| @ffprobe-installer/* | `postinstall: chmod u+x ffprobe` | Trivial. |
| onnxruntime-node 1.22.0 / 1.24.3 | `postinstall: node ./script/install` | Downloads optional GPU runtimes from NuGet. **Skipped** in builds (`ONNXRUNTIME_NODE_INSTALL=skip`); CPU binaries ship inside the package. |
| koffi 3.2.1 | `install: node ./cnoke.cjs --prebuild` | Selects a prebuilt binary. |
| protobufjs 7.6.5 | `postinstall` | Version check. |
| electron-winstaller 5.4.0 (dev) | `install` | Selects its 7-Zip binary. |
| fsevents (dev, macOS only) | native build | Not used on Windows. |

npm 11 warns that these scripts are "not yet covered by allowScripts". A
follow-up can set `allowScripts` in `.npmrc` to exactly this list so that any
new install script fails the build.

## Native binaries shipped in the Windows package

| Binary | Source | Integrity control |
|---|---|---|
| Electron 43.1.1 runtime | electron-builder download from GitHub releases | electron-builder verifies SHA-256 sums from the release |
| `ffmpeg.exe` (FFmpeg 6.1.1 static, GPL) | ffmpeg-static b6.1.1 | Recorded SHA-256; no upstream checksum |
| `ffprobe.exe` | @ffprobe-installer/win32-x64 5.1.0 | npm integrity (lockfile) |
| Remotion compositor (`remotion.exe`, its own ffmpeg/ffprobe) | @remotion/compositor-win32-x64-msvc 4.0.509 | npm (`npm pack` at the renderer's exact version) |
| chrome-headless-shell 149.0.7790.0 | Chrome for Testing (storage.googleapis.com) | HTTPS only. Chrome for Testing publishes no checksums |
| whisper.cpp v1.9.2 (`whisper-cli.exe`, `whisper-server.exe`, ggml DLLs) | GitHub release `whisper-bin-x64.zip` | **Pinned size + SHA-256** verified before extraction; provenance record written next to the binary |
| onnxruntime (`onnxruntime.dll`, DirectML) | onnxruntime-node 1.22.0 / 1.24.3 | npm integrity |
| sqlite-vec `vec0.dll` | sqlite-vec-windows-x64 0.1.9 | npm integrity |
| sharp/libvips | @img/sharp-win32-x64 0.35.4 | npm integrity |
| koffi, @napi-rs/canvas, @rspack/binding, esbuild | npm platform packages | npm integrity |
| GitHub Copilot CLI (`copilot.exe`, `rg.exe`, computer-use plugin) | @github/copilot-win32-x64 1.0.82 | npm integrity. Launched only when the user selects the Copilot agent backend |

## Deprecated / unmaintained packages (transitive)

`inflight@1.0.6` (memory leak, unmaintained), `glob@7.2.3`, `glob@11.1.0`,
`rimraf@2.6.3`, `boolean@3.2.0`, `lodash.isequal@4.5.0`,
`prebuild-install@7.1.3`. All are pulled in by build tooling or by
electron-builder/remotion transitive dependencies. None processes untrusted
input at runtime. They are kept because replacing them requires upstream
releases.

## Packages shipped although not needed at runtime

`@remotion/bundler` (webpack, rspack, esbuild JS) is a production dependency.
The packaged app renders from the prebuilt bundle, but the main bundle still
imports these modules at load, so they ship. The native rspack/esbuild
bindings for other operating systems are excluded from the package.

## Licenses (production graph)

MIT 469, Apache-2.0 91, ISC 35, BSD-3-Clause 20, BlueOak-1.0.0 12,
BSD-2-Clause 12, LGPL-3.0-or-later 10 (libvips), GPL-3.0 (FFmpeg / FFprobe
builds), LGPL-3.0 (heic-to), MPL-2.0 4, and others.

Distribution obligations to be aware of:

- **OpenChatCut itself is AGPL-3.0-or-later.** Distributing binaries requires
  offering the corresponding source.
- **FFmpeg static builds are GPL-3.0.** Compatible with AGPL distribution;
  their license texts must be included.
- **Remotion** (`remotion`, `@remotion/*`) is under the Remotion License
  ("SEE LICENSE IN LICENSE.md"), which requires a paid company license for
  for-profit organizations above its size threshold. Distributors must check
  that they are eligible.
- **GitHub Copilot CLI** is under GitHub's own terms ("SEE LICENSE IN
  LICENSE.md").
- `@remotion/compositor-*`, `@remotion/media` and `parse-cache-control` declare
  no SPDX license in their package metadata.
