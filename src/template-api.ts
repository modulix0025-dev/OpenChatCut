// The template API in one place: the globals a code-backed template may use.
// src/template-host.ts injects exactly these, and the motion-graphics
// generator prompt (src/agent/tools/core-tools.ts) advertises exactly these,
// so what the model is told and what the sandbox accepts cannot drift apart.
// To add a Remotion component: add its name here and inject it in
// template-host.ts (WHITELIST, plus TRUSTED_COMPONENT_OBJECTS when it is a
// forwardRef/memo object). template-host.security.verify.ts checks both.
export const TEMPLATE_GLOBAL_NAMES = [
  'React', 'useCurrentFrame', 'useVideoConfig', 'interpolate', 'interpolateColors',
  'spring', 'Easing', 'random', 'Img', 'Video', 'Audio', 'Sequence', 'AbsoluteFill', 'staticFile',
  'OffthreadVideo', 'Series', 'Loop', 'Freeze',
] as const;

/** Component rules the sandbox enforces, phrased for a code-writing model. */
export const TEMPLATE_COMPONENT_RULES =
  'Write only function components (arrow functions or function declarations); class components, React.forwardRef and React.lazy are not available. React.memo around your own function components is fine.';
