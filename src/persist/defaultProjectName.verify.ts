// New projects are named in the interface language with the date and time,
// not a random Chinese word pair.
import assert from 'node:assert/strict';
import { setLocale } from '../i18n/locale';
import { ensureLocaleDict } from '../i18n/dictRegistry';
import { defaultProjectName } from './projectStore';

const when = new Date(2026, 8, 27, 14, 5);
setLocale('en');
await ensureLocaleDict('en');
const english = defaultProjectName(when);
assert.match(english, /^New project /);
assert.match(english, /27\/09\/2026/);
assert.match(english, /14:05/);
assert.doesNotMatch(english, /[㐀-鿿]/, 'no Chinese in an English interface');
setLocale('ru');
await ensureLocaleDict('ru');
assert.match(defaultProjectName(when), /^Новый проект 27\.09\.2026/);
setLocale('zh');
assert.match(defaultProjectName(when), /^新工程 2026\/09\/27/);
console.log('defaultProjectName.verify: localized name with date');
