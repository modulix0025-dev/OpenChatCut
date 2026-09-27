// The Claude Code model picker comes from the capability catalog plus the
// user's extra ids, so new models appear without editing a hard-coded list.
import assert from 'node:assert/strict';
import { claudeCodeModelList, claudeModelLabel, parseExtraModels } from './models.ts';

const models = claudeCodeModelList();
const ids = models.map((model) => model.id);
for (const id of ['claude-opus-5-5', 'claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5', 'claude-fable-5-1']) {
  assert.ok(ids.includes(id), `${id} is offered`);
}
assert.equal(models.find((model) => model.id === 'claude-opus-5-5')?.label, 'Claude Opus 5.5');
assert.ok(!ids.some((id) => /-\d{8}$/.test(id)), 'dated snapshot ids are left out');
assert.deepEqual(models.filter((model) => model.isDefault).map((model) => model.id), ['claude-sonnet-5']);
assert.ok(ids.indexOf('claude-opus-5-5') < ids.indexOf('claude-opus-5'), 'newest first');
assert.equal(new Set(ids).size, ids.length, 'no duplicates');

// A catalog refresh alone adds a model.
assert.ok(claudeCodeModelList('', ['claude-opus-6']).some((model) => model.id === 'claude-opus-6'));

// Extra ids from settings: appended once, invalid CLI tokens dropped.
const withExtras = claudeCodeModelList('claude-experimental-x, --settings=evil claude-opus-5-5\nclaude-new');
const extraIds = withExtras.map((model) => model.id);
assert.ok(extraIds.includes('claude-experimental-x'));
assert.ok(extraIds.includes('claude-new'));
assert.ok(!extraIds.some((id) => id.startsWith('-')), 'an option-looking value never becomes a model id');
assert.equal(extraIds.filter((id) => id === 'claude-opus-5-5').length, 1);
assert.deepEqual(parseExtraModels(' , '), []);
assert.equal(claudeModelLabel('claude-haiku-4-5'), 'Claude Haiku 4.5');
assert.equal(claudeModelLabel('custom-model'), 'custom-model');
console.log('claude-code models.verify: catalog-driven list with Opus 5.5 and extra ids');
