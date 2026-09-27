// Capability guard for code-backed templates (see template-host.ts for the
// layered model). Kept free of React/Remotion imports so it can be verified in
// plain Node.
//
// A template may only name identifiers it declares itself, the injected
// template API, or the pure built-ins below. Everything else — `window`,
// `openChatCutDesktop`, `fetch`, `document`, `Function`, `Reflect`, … — is
// rejected before the code is evaluated. Property access is constrained too:
// the names in DENIED_TEMPLATE_KEYS lead from ordinary values back to the
// global object, the Function constructor, or the rest of the editor DOM, so
// they are refused as literal names and, for computed access, by a runtime
// guard that runs after the key has been converted to its final string.

/** Runtime key guard injected into the evaluated template scope. */
export const TEMPLATE_KEY_GUARD = '__occTemplateKey';

/** Pure built-ins a template may reference by name. */
export const SAFE_TEMPLATE_GLOBAL_NAMES: readonly string[] = [
  'Math', 'JSON', 'Number', 'String', 'Boolean', 'Array', 'Date', 'Map', 'Set',
  'WeakMap', 'WeakSet', 'Symbol', 'Promise', 'Intl', 'BigInt', 'Error', 'TypeError',
  'RangeError', 'RegExp', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'NaN', 'Infinity',
  'undefined', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
  'Float32Array', 'Float64Array', 'Uint8Array', 'Uint8ClampedArray', 'Uint16Array',
  'Int8Array', 'Int16Array', 'Int32Array', 'Uint32Array', 'console', 'Object',
];

/**
 * Property names that escape the template scope: the Function constructor and
 * prototype chain, V8 stack hooks, and DOM links from a template's own element
 * (a ref or event target) up to the document, window or other editor UI.
 * Any key starting with `_` is denied as well (React internals). Window-only names such as
 * `top`/`parent`/`self` stay allowed (`style.top` is common): the window itself
 * is unreachable, so they only ever name ordinary data.
 */
export const DENIED_TEMPLATE_KEYS: ReadonlySet<string> = new Set([
  'constructor', 'prototype', 'caller', 'callee', 'arguments',
  'prepareStackTrace', 'captureStackTrace', 'stackTraceLimit',
  'ownerDocument', 'defaultView', 'getRootNode', 'parentNode', 'parentElement',
  'offsetParent', 'closest', 'composedPath', 'view', 'contentWindow', 'contentDocument',
  'frameElement', 'window', 'globalThis', 'document', 'location', 'cookie', 'srcdoc', 'innerHTML', 'outerHTML',
  'insertAdjacentHTML', 'setHTMLUnsafe', 'createContextualFragment', 'write', 'writeln',
  'execCommand', 'previousSibling', 'nextSibling', 'previousElementSibling',
  'nextElementSibling', 'assignedSlot', 'shadowRoot', 'attachShadow',
  'openChatCutDesktop', 'relatedTarget', 'srcElement',
  // React fiber / internals reachable from components, refs and events.
  'stateNode', 'memoizedState', 'memoizedProps', 'pendingProps', 'alternate',
  'containerInfo', 'updater', 'nativeEvent', 'dispatchConfig',
]);

export function isDeniedTemplateKey(key: string): boolean {
  // Any leading underscore: React keeps its fiber on `_reactInternals` (class
  // instances) and `__reactFiber$…` / `__reactProps$…` (DOM nodes); walking a
  // fiber reaches every component's state and callbacks in the editor.
  return key.startsWith('_') || DENIED_TEMPLATE_KEYS.has(key);
}

/** Runtime guard for `obj[expr]`: returns the final property key or throws. */
export function guardTemplateKey(key: unknown): string | symbol | number {
  if (typeof key === 'number') return key;
  if (typeof key === 'symbol') return key;
  const text = String(key);
  if (isDeniedTemplateKey(text)) throw new Error(`template: property "${text}" is not allowed`);
  return text;
}

const SAFE_OBJECT = Object.freeze({
  keys: Object.keys,
  values: Object.values,
  entries: Object.entries,
  assign: Object.assign,
  freeze: Object.freeze,
  isFrozen: Object.isFrozen,
  fromEntries: Object.fromEntries,
  is: Object.is,
  hasOwn: Object.hasOwn,
  create: (proto: object | null) => {
    if (proto !== null) throw new Error('template: Object.create only accepts null');
    return Object.create(null) as object;
  },
});

/** Values bound to SAFE_TEMPLATE_GLOBAL_NAMES in the template scope. */
export function safeTemplateGlobals(): Record<string, unknown> {
  const globals: Record<string, unknown> = {};
  for (const name of SAFE_TEMPLATE_GLOBAL_NAMES) {
    if (name === 'Object') globals.Object = SAFE_OBJECT;
    else if (name !== 'undefined' && name !== 'NaN' && name !== 'Infinity') {
      globals[name] = (globalThis as Record<string, unknown>)[name];
    }
  }
  return globals;
}

// Minimal structural types for the parts of Babel this guard uses.
interface BabelNode { type: string; [key: string]: unknown }
interface BabelPath {
  node: BabelNode;
  scope: { hasBinding(name: string, noGlobals?: boolean): boolean };
  get(key: string): BabelPath;
  traverse(visitor: Record<string, (path: BabelPath) => void>): void;
  isReferencedIdentifier(): boolean;
  parentPath: BabelPath | null;
}
interface BabelTypes {
  callExpression(callee: BabelNode, args: BabelNode[]): BabelNode;
  identifier(name: string): BabelNode;
}
export interface BabelLike {
  transform(code: string, options: Record<string, unknown>): { code?: string | null } | null;
}

function fail(reason: string): never {
  throw new Error(`sandbox 拒绝：${reason}`);
}

function checkStaticKey(key: BabelNode | undefined, computed: boolean): void {
  if (!key) return;
  if (!computed && key.type === 'Identifier' && isDeniedTemplateKey(String(key.name))) {
    fail(`property "${String(key.name)}"`);
  }
  if (key.type === 'StringLiteral' && isDeniedTemplateKey(String(key.value))) {
    fail(`property "${String(key.value)}"`);
  }
  if (key.type === 'PrivateName') return;
}

function isGuardCall(node: BabelNode): boolean {
  const callee = node.callee as BabelNode | undefined;
  return node.type === 'CallExpression' && callee?.type === 'Identifier' && callee.name === TEMPLATE_KEY_GUARD;
}

/** Babel plugin: validates identifiers and property names, wraps computed keys. */
export function templateGuardPlugin(allowedNames: readonly string[]) {
  const allowed = new Set([...allowedNames, ...SAFE_TEMPLATE_GLOBAL_NAMES]);
  return ({ types: t }: { types: BabelTypes }) => {
    const wrapComputed = (path: BabelPath, key: string): void => {
      const property = path.node[key] as BabelNode;
      if (!property || property.type === 'NumericLiteral' || property.type === 'StringLiteral') return;
      if (isGuardCall(property)) return;
      path.node[key] = t.callExpression(t.identifier(TEMPLATE_KEY_GUARD), [property]);
    };
    const validate: Record<string, (path: BabelPath) => void> = {
      Identifier(path) {
        const name = String(path.node.name);
        if (name.startsWith('__occ')) fail(`reserved identifier "${name}"`);
        if (name === 'eval' || name === 'arguments') fail(name);
        if (!path.isReferencedIdentifier()) return;
        if (path.scope.hasBinding(name, true)) return;
        if (!allowed.has(name)) fail(`global "${name}" is not available to templates`);
      },
      MemberExpression(path) { checkStaticKey(path.node.property as BabelNode, Boolean(path.node.computed)); },
      OptionalMemberExpression(path) { checkStaticKey(path.node.property as BabelNode, Boolean(path.node.computed)); },
      ObjectProperty(path) {
        const key = path.node.key as BabelNode;
        // Destructuring reads a property, so it obeys the same key rules as `a.b`.
        if (path.parentPath?.node.type === 'ObjectPattern') {
          checkStaticKey(key, Boolean(path.node.computed));
          return;
        }
        // Object literals only define own properties (`{ top: 60 }` is a style);
        // the one key that changes semantics there is a literal `__proto__`.
        if (!path.node.computed && (key.name === '__proto__' || key.value === '__proto__')) {
          fail('__proto__ literal');
        }
      },
      MetaProperty() { fail('import.meta / new.target'); },
      Import() { fail('dynamic import()'); },
      ImportDeclaration() { fail('import statement'); },
      ExportNamedDeclaration() { fail('export'); },
      ExportDefaultDeclaration() { fail('export'); },
      WithStatement() { fail('with'); },
      DebuggerStatement() { fail('debugger'); },
      TaggedTemplateExpression(path) {
        const tag = path.node.tag as BabelNode;
        // String.raw is the only tag a drawing needs; others can smuggle calls.
        const ok = tag.type === 'MemberExpression'
          && (tag.object as BabelNode).type === 'Identifier' && (tag.object as BabelNode).name === 'String'
          && (tag.property as BabelNode).type === 'Identifier' && (tag.property as BabelNode).name === 'raw';
        if (!ok) fail('tagged template');
      },
    };
    const rewrite: Record<string, (path: BabelPath) => void> = {
      MemberExpression(path) { if (path.node.computed) wrapComputed(path, 'property'); },
      OptionalMemberExpression(path) { if (path.node.computed) wrapComputed(path, 'property'); },
      ObjectProperty(path) {
        if (path.node.computed && path.parentPath?.node.type === 'ObjectPattern') wrapComputed(path, 'key');
      },
    };
    return {
      visitor: {
        Program(path: BabelPath) {
          path.traverse(validate);
          path.traverse(rewrite);
        },
      },
    };
  };
}

/**
 * Validate and rewrite already-transpiled (JSX-free) template code. Throws on
 * any capability violation; returns code whose computed member accesses all
 * pass through TEMPLATE_KEY_GUARD.
 */
export function guardTemplateSource(babel: BabelLike, code: string, allowedNames: readonly string[]): string {
  const result = babel.transform(code, {
    filename: 'template.guard.js',
    sourceType: 'script',
    parserOpts: { allowReturnOutsideFunction: false },
    plugins: [templateGuardPlugin(allowedNames)],
    babelrc: false,
    configFile: false,
    compact: false,
  });
  if (!result?.code) throw new Error('template: guard produced no output');
  return result.code;
}
