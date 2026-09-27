// The "drop-in seam" + a sandbox for evaluating templates.
//
// Templates are no-import `({item}) => JSX` arrow functions that use
// INJECTED globals. They can be AI-generated, imported from a project file, or
// installed from a plugin URL, so evaluating them is a security-critical path
// (arbitrary JS runs every frame inside the privileged editor renderer).
//
// Defense in depth (four layers):
//   1. static blocklist — reject code containing network / storage / DOM-escape
//      / dynamic-code / infinite-loop patterns before it ever parses.
//   2. AST capability check (template-guard.ts) — every free identifier must be
//      on an explicit allowlist (so `openChatCutDesktop`, `window`, `fetch`, … are
//      unreachable by name), dangerous property names (`constructor`,
//      `__proto__`, `ownerDocument`, `defaultView`, …) are rejected statically,
//      and every computed member access `obj[expr]` is rewritten through a runtime
//      key guard so string-building tricks cannot reach them either.
//   3. restricted scope — the eval Function receives only the allowlisted
//      globals and runs in strict mode (no implicit globals, `this` === undefined).
//   4. element filter — createElement refuses script/iframe/object/embed/base/
//      form/link/meta elements, strips srcDoc/formAction, and only lets
//      dangerouslySetInnerHTML through when the markup parses to inert content.
//
// The packaged desktop app additionally serves a Content-Security-Policy that
// forbids inline and remote scripts, so injected markup cannot execute code.
// This is still not a hard VM boundary; see docs/security/THREAT_MODEL.md.
import * as React from 'react';
import {
  useCurrentFrame, useVideoConfig, interpolate, interpolateColors,
  spring, Easing, random, Img as RemotionImg, Video, Audio, Sequence, AbsoluteFill, staticFile,
} from 'remotion';
import {
  TEMPLATE_KEY_GUARD,
  guardTemplateKey,
  safeTemplateGlobals,
  guardTemplateSource,
} from './template-guard';

export type MgItem = { props: Record<string, unknown>; width: number; height: number };
export type MgComponent = React.FC<{ item: MgItem }>;

// Scraped templates often carry a DANGLING bgImage — a bare asset id like
// "04ff45a7b0" (not a URL). In the browser Player that just 404s harmlessly, but
// under headless render Remotion's <Img> waits on delayRender() until it times // impeccable-disable-line broken-image -- Remotion <Img> mentioned in comments, not a real tag
// out (fatal). So: only render an <Img> when the src is a genuinely loadable URL
// (http/https/data/blob or a root path); otherwise render nothing. For a real
// URL that still fails, onError makes Remotion swallow it instead of throwing.
const isLoadableSrc = (src: unknown): boolean =>
  typeof src === 'string' && /^(https?:|data:|blob:|\/)/.test(src.trim());

const Img: React.FC<Record<string, unknown>> = (props) =>
  isLoadableSrc(props.src)
    ? React.createElement(RemotionImg, {
        ...props,
        onError: props.onError ?? (() => undefined),
      } as React.ComponentProps<typeof RemotionImg>)
    : null;

// MG codegen (including imported MG) sometimes treats pure CSS camel case properties as JSX properties and writes them directly in
// On a host/SVG element, for example `<rect mixBlendMode="overlay" />`. React 19 will report both warning and
// Just discard it - blended mode silently fails. `mix-blend-mode` is CSS-only (never legal DOM/SVG
// attribute), so it is always right to move it into style when creatingElement: both to eliminate the warning and to make the mix really effective.
// Only move this attribute with zero ambiguity (filter/mask/clipPath, etc. are legal SVG attributes and must not be touched).
const CSS_ONLY_PROPS = ['mixBlendMode'] as const;

// Elements that can load or run code, navigate the editor, or rewrite how the
// document resolves URLs. None is needed to draw a frame.
const BLOCKED_TEMPLATE_ELEMENTS: ReadonlySet<string> = new Set([
  'script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'base',
  'link', 'meta', 'form', 'portal', 'webview', 'noscript', 'template', 'slot',
]);
const BLOCKED_TEMPLATE_PROPS = ['srcDoc', 'srcdoc', 'formAction', 'action', 'is'] as const;

/** True when `html` parses to markup with no scripts, handlers or code URLs. */
export function isInertTemplateMarkup(html: unknown): boolean {
  if (typeof html !== 'string') return false;
  if (typeof DOMParser === 'undefined') return false;
  // Parsing into a detached document never runs scripts or loads resources.
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}`, 'text/html');
  for (const el of Array.from(doc.body.querySelectorAll('*'))) {
    const tag = el.localName.toLowerCase();
    if (BLOCKED_TEMPLATE_ELEMENTS.has(tag) || tag === 'foreignobject' || tag === 'style') return false;
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) return false;
      // Browsers ignore leading controls/whitespace in URLs ("\u0001javascript:").
      const value = attr.value.split('').filter((ch) => ch.charCodeAt(0) > 0x20).join('').toLowerCase();
      if (/^(javascript|vbscript|data:text\/html)/.test(value)) return false;
      if ((name === 'href' || name.endsWith(':href') || name === 'src') && !value.startsWith('#')) return false;
    }
  }
  return true;
}

const createElementSafe = ((type: unknown, props: unknown, ...children: unknown[]) => {
  // Rendered as nothing (not thrown) so one hostile node cannot blank the preview.
  if (typeof type === 'string' && BLOCKED_TEMPLATE_ELEMENTS.has(type.toLowerCase())) return null;
  if (typeof type === 'string' && props && typeof props === 'object') {
    let p = props as Record<string, unknown>;
    if (BLOCKED_TEMPLATE_PROPS.some((key) => key in p) || 'dangerouslySetInnerHTML' in p) {
      const rest = { ...p };
      for (const key of BLOCKED_TEMPLATE_PROPS) delete rest[key];
      const inner = rest.dangerouslySetInnerHTML as { __html?: unknown } | undefined;
      if (inner !== undefined && !isInertTemplateMarkup(inner?.__html)) delete rest.dangerouslySetInnerHTML;
      p = rest;
      props = rest;
    }
    let moved: Record<string, unknown> | null = null;
    for (const key of CSS_ONLY_PROPS) {
      if (key in p) (moved ??= {})[key] = p[key];
    }
    if (moved) {
      const { style, ...rest } = p;
      // Key: Delete the moved attribute from rest, otherwise it will still remain as a DOM attribute → React will still report a warning.
      for (const key of CSS_ONLY_PROPS) delete (rest as Record<string, unknown>)[key];
      // Explicit style overwrites the moved value (if the author also writes style.mixBlendMode, it shall prevail).
      props = { ...rest, style: { ...moved, ...(style as object | undefined) } };
    }
  }
  return React.createElement(type as never, props as never, ...(children as React.ReactNode[]));
}) as typeof React.createElement;

// Exactly the same as real React, only createElement plus the above host-property→style return.
// Use Proxy to forward all other members (Fragment/hooks/…), not affected by enumerability.
const HostReact = new Proxy(React, {
  get: (target, prop, recv) => {
    if (prop === 'createElement') return createElementSafe;
    // React's internals object and legacy hooks are not part of the template API.
    if (typeof prop === 'string' && (prop.startsWith('__') || prop === 'createFactory')) return undefined;
    return Reflect.get(target, prop, recv);
  },
});

// The only globals a template legitimately needs (verified across all 211).
const WHITELIST: Record<string, unknown> = {
  React: HostReact, useCurrentFrame, useVideoConfig, interpolate, interpolateColors,
  spring, Easing, random, Img, Video, Audio, Sequence, AbsoluteFill, staticFile,
};

// Everything reachable that a template must NOT touch → shadowed to undefined.
// NB: 'eval' and 'arguments' are reserved in strict mode and CANNOT be
// parameter names — they are blocked by the static check instead.
const SHADOW = [
  'window', 'self', 'globalThis', 'document', 'navigator', 'location', 'history',
  'parent', 'top', 'opener', 'frames', 'Function', 'require', 'module',
  'exports', 'process', 'importScripts', 'postMessage', 'fetch', 'XMLHttpRequest',
  'WebSocket', 'EventSource', 'localStorage', 'sessionStorage', 'indexedDB',
  'setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask', 'requestAnimationFrame',
  'alert', 'prompt', 'confirm', 'open', 'Worker', 'SharedWorker', 'Notification',
];

// Layer 1: static blocklist (targets usage patterns, not bare words in comments).
const FORBIDDEN: [RegExp, string][] = [
  [/\bimport\s*[({]/, 'dynamic import()'],
  [/(^|[^.\w])import\s+[\w{*"']/m, 'import statement'],
  [/\brequire\s*\(/, 'require()'],
  [/\beval\b/, 'eval (any form)'],
  [/\barguments\b/, 'arguments'],
  [/\bnew\s+Function\b/, 'new Function'],
  [/\.\s*constructor\b/, '.constructor (escape vector)'],
  [/\bwindow\s*[.[]/, 'window access'],
  [/\bdocument\s*[.[]/, 'document access'],
  [/\bglobalThis\b/, 'globalThis'],
  [/\bfetch\s*\(/, 'fetch()'],
  [/\bnew\s+(XMLHttpRequest|WebSocket|EventSource|Worker)\b/, 'network/worker'],
  [/\b(localStorage|sessionStorage|indexedDB)\s*[.[]/, 'storage access'],
  [/\.\s*cookie\b/, 'cookie access'],
  [/\bimportScripts\b/, 'importScripts'],
  [/\b(setTimeout|setInterval)\s*\(/, 'timers'],
  [/while\s*\(\s*true\s*\)/, 'infinite loop while(true)'],
  [/for\s*\(\s*;\s*;\s*\)/, 'infinite loop for(;;)'],
  [/\bdebugger\b/, 'debugger'],
];

// strip comments so prose like "video window." doesn't trip the blocklist.
// (only used for the security scan — the original code is what actually runs.)
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

export function validateTemplate(code: string): void {
  const scan = stripComments(code);
  for (const [re, reason] of FORBIDDEN) {
    if (re.test(scan)) throw new Error(`sandbox 拒绝：检测到「${reason}」`);
  }
}

const cache = new Map<string, MgComponent>();
const pending = new Map<string, Promise<MgComponent>>();

function templateName(code: string): string {
  const itemSignature = code.match(
    /const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(\s*\{[^)}]*\bitem\b[^)}]*\}/,
  );
  const fallback = code.match(/const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\(|async\b|function)/);
  const name = (itemSignature ?? fallback)?.[1];
  if (!name) throw new Error('template: 找不到 `const NAME = (...)` 声明');
  return name;
}

function evaluateTemplate(transpiled: string, name: string): MgComponent {
  const globals = safeTemplateGlobals();
  const shadow = SHADOW.filter((key) => !(key in globals) && !(key in WHITELIST));
  const names = [...Object.keys(WHITELIST), ...Object.keys(globals), TEMPLATE_KEY_GUARD, ...shadow];
  const values = [
    ...Object.values(WHITELIST), ...Object.values(globals), guardTemplateKey, ...shadow.map(() => undefined),
  ];
  const factory = new Function(...names, `"use strict";\n${transpiled}\n;return ${name};`);
  return factory(...values) as MgComponent;
}

async function compileUncached(code: string): Promise<MgComponent> {
  validateTemplate(code);
  const name = templateName(code);
  // Compiler boundary: user/plugin JSX is the only path allowed to load Babel.
  const Babel = await import('@babel/standalone');
  const output = Babel.transform(code, {
    presets: [['react', { runtime: 'classic' }]],
    filename: 'template.jsx',
  }).code;
  if (!output) throw new Error('template: babel 无输出');
  const guarded = guardTemplateSource(Babel, output, Object.keys(WHITELIST));
  return evaluateTemplate(guarded, name);
}

/** Validate, compile, and cache one code-backed template before it can render. */
export function prepareTemplate(code: string): Promise<MgComponent> {
  const compiled = cache.get(code);
  if (compiled) return Promise.resolve(compiled);
  const inFlight = pending.get(code);
  if (inFlight) return inFlight;
  const promise = compileUncached(code).then(
    (component) => {
      cache.set(code, component);
      pending.delete(code);
      return component;
    },
    (error: unknown) => {
      pending.delete(code);
      throw error;
    },
  );
  pending.set(code, promise);
  return promise;
}

/** Synchronous render path. Call prepareTemplate() at a readiness boundary first. */
export function getCompiledTemplate(code: string): MgComponent {
  const compiled = cache.get(code);
  if (!compiled) throw new Error('template: 尚未完成编译');
  return compiled;
}
