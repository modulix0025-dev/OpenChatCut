// Content-Security-Policy for the packaged editor document (pure: no Electron
// imports, so it can be verified in plain Node). Applied by
// desktop/security-policy.ts to every response from the embedded origin.
/**
 * CSP for the packaged editor. 'unsafe-eval' remains because code-backed
 * templates are compiled with `new Function` (after the template guard) and
 * several dependencies (ajv schema compilation, onnxruntime-web) need it;
 * 'wasm-unsafe-eval' is required for WebAssembly decoders and models. Neither
 * permits loading script from anywhere but the editor origin.
 * Network sinks stay open to https: because generation providers return media
 * on arbitrary CDNs; see docs/security/THREAT_MODEL.md.
 */
export function editorContentSecurityPolicy(): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' blob:",
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: blob: https:",
    "img-src 'self' data: blob: https: http:",
    "media-src 'self' data: blob: https: http:",
    "connect-src 'self' https: wss: data: blob:",
    "frame-src 'self' blob: data:",
    "child-src 'self' blob: data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}
