# Code signing (Windows)

**Code signing is not configured because a trusted production certificate was
not provided.** The Windows installer and portable executable produced from
this repository are **unsigned**:

- Windows SmartScreen shows "Windows protected your PC / Unknown publisher" on
  first run. Users must choose *More info → Run anyway*.
- The Authenticode "Publisher" field is empty, so users cannot verify who built
  the binary. Verify downloads against the published SHA-256 checksums instead.
- A successful build does **not** make an unsigned executable trusted.
- In-app self-update is disabled for these builds (`package.json`
  `openchatcut.directUpdates: false`). With a signing identity, electron-updater
  can verify that an update is signed by the same publisher before installing
  it.

No certificate, private key or signing password is stored in this repository,
in CI configuration, or in the built artifacts. Never commit them.

## Configuring a legitimate certificate

electron-builder signs every Windows executable it produces, including the app,
the bundled helper `.exe` files, the NSIS installer/uninstaller and the portable
wrapper, when signing credentials are present in the **build environment**.

### Option A — Azure Trusted Signing (recommended; no key on the build machine)

1. Create a Trusted Signing account and certificate profile in Azure, then
   complete identity validation.
2. Create an app registration with the *Trusted Signing Certificate Profile
   Signer* role.
3. Add to `config/electron-builder.config.mjs` under `win`:
   ```js
   azureSignOptions: {
     publisherName: 'Your Legal Name',
     endpoint: 'https://<region>.codesigning.azure.net',
     certificateProfileName: '<profile>',
     codeSigningAccountName: '<account>',
   },
   ```
4. Provide `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET` as CI
   secrets (never in the repo). Windows signing with Azure runs on a Windows
   build host.

### Option B — OV/EV certificate in a cloud HSM or hardware token

Since June 2023, CA/B Forum rules require code-signing keys to live on an HSM or
token. Use your CA's signing service (DigiCert KeyLocker, SSL.com eSigner, …)
through a custom `win.signtoolOptions.sign` hook, or sign on a Windows host that
has the token attached.

### Option C — PFX file (legacy certificates only)

```
CSC_LINK=<path or base64 of the .pfx>      # or WIN_CSC_LINK
CSC_KEY_PASSWORD=<password>                # or WIN_CSC_KEY_PASSWORD
```

Set these as masked CI secrets. electron-builder picks them up automatically.

### After signing is configured

1. Set `"openchatcut": { "directUpdates": true }` in `package.json` only if you
   publish your own update feed. Also set `win.publisherName` to the exact
   certificate subject so electron-updater rejects updates signed by anyone
   else, and point `publish` at your own releases repository.
2. Verify on Windows:
   ```powershell
   Get-AuthenticodeSignature .\OpenChatCut-<version>-x64.exe | Format-List
   signtool verify /pa /v .\OpenChatCut-<version>-x64.exe
   ```
   Both must report a valid signature chaining to a trusted root with your
   publisher name.
3. Keep timestamping enabled (the electron-builder default) so signatures stay
   valid after the certificate expires.

Do not create self-signed certificates for distribution. They give users no
trust and train them to click through warnings.
