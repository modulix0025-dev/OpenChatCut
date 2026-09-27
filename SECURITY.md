# Security

The OpenChatCut desktop app runs as a standard user with a default-deny
permission model. Anything privileged needs your explicit permission in a
native dialog: running programs, reaching folders you did not pick,
redirecting API keys, LAN access, and external-agent auto-approval.

| Document | Contents |
|---|---|
| [security/SECURITY_AUDIT.md](security/SECURITY_AUDIT.md) | Architecture, findings and fixes, remaining risks |
| [security/THREAT_MODEL.md](security/THREAT_MODEL.md) | Trust boundaries and a risk register traced to code |
| [security/PERMISSION_MODEL.md](security/PERMISSION_MODEL.md) | Capabilities, the permission dialog, what the app can and cannot access |
| [security/DEPENDENCY_REPORT.md](security/DEPENDENCY_REPORT.md) | Vulnerabilities, supply chain, native binaries, licenses, SBOM |
| [security/VERIFICATION.md](security/VERIFICATION.md) | Release hashes, package checks, malware scan, test results |
| [security/BUILD_AND_INSTALL.md](security/BUILD_AND_INSTALL.md) | Build, install, uninstall, data locations |
| [security/CODE_SIGNING.md](security/CODE_SIGNING.md) | Signing status and how to configure a certificate |

Security regression tests: `npm run verify:security` (also part of `npm test`).

To report a vulnerability, open a private security advisory on the GitHub
repository rather than a public issue.
