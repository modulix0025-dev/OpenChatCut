// The Claude Code model picker, derived from the shared capability catalog
// (assets/model-capabilities/models-dev.json) instead of a hand-kept list, so
// a catalog refresh (scripts/update-llm-model-capabilities.mjs) brings new
// models in without code changes. Users can add more ids in settings
// (CLAUDE_CODE_EXTRA_MODELS, comma-separated).
import modelsDevCatalog from '../../assets/model-capabilities/models-dev.json' with { type: 'json' };
import type { ClaudeCodeAgentModel } from '../../shared/claude-code-agent.ts';

/** Default selection when nothing is saved. */
export const DEFAULT_CLAUDE_CODE_MODEL = 'claude-sonnet-5';

/**
 * Released models the bundled catalog snapshot predates. models.dev lists
 * them; drop an entry here once a catalog refresh includes it.
 */
export const MODELS_NEWER_THAN_CATALOG: readonly string[] = ['claude-opus-5-5', 'claude-fable-5-1'];

const FAMILY_ORDER = ['fable', 'opus', 'sonnet', 'haiku'];
const MODEL_ID = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/;
const CLI_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@[\]/-]{0,127}$/;

interface ParsedModel {
  readonly id: string;
  readonly family: string;
  readonly major: number;
  readonly minor: number;
}

/** Canonical, undated ids only ("claude-opus-5-5", not "...-20251101"). */
function parse(id: string): ParsedModel | null {
  const match = MODEL_ID.exec(id);
  if (!match) return null;
  const minor = match[3] === undefined ? 0 : Number(match[3]);
  if (minor > 99) return null; // a date suffix, not a minor version
  return { id, family: match[1]!, major: Number(match[2]), minor };
}

export function claudeModelLabel(id: string): string {
  const parsed = parse(id);
  if (!parsed) return id;
  const family = parsed.family.charAt(0).toUpperCase() + parsed.family.slice(1);
  return `Claude ${family} ${parsed.major}${parsed.minor ? `.${parsed.minor}` : ''}`;
}

function catalogAnthropicIds(): string[] {
  const providers = (modelsDevCatalog as { providers?: Record<string, Record<string, unknown>> }).providers;
  return Object.keys(providers?.anthropic ?? {});
}

/** Valid extra ids from the comma/space/newline separated setting. */
export function parseExtraModels(setting: string): string[] {
  return setting.split(/[\s,]+/).map((value) => value.trim()).filter((value) => CLI_TOKEN.test(value));
}

export function claudeCodeModelList(extraSetting = '', catalogIds: readonly string[] = catalogAnthropicIds()): ClaudeCodeAgentModel[] {
  const known = [...new Set([...catalogIds, ...MODELS_NEWER_THAN_CATALOG])]
    .map(parse)
    .filter((model): model is ParsedModel => model !== null)
    .sort((a, b) => b.major - a.major || b.minor - a.minor
      || FAMILY_ORDER.indexOf(a.family) - FAMILY_ORDER.indexOf(b.family));
  const ids = [...known.map((model) => model.id)];
  for (const extra of parseExtraModels(extraSetting)) if (!ids.includes(extra)) ids.push(extra);
  return ids.map((id) => ({ id, label: claudeModelLabel(id), isDefault: id === DEFAULT_CLAUDE_CODE_MODEL }));
}
