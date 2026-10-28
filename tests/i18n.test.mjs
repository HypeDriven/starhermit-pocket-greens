// Every player-facing key the engine client uses (tests/i18n-keys.mjs) exists in all nine
// locales with the same {placeholders}; the locale picker maps tags as the runtime reports them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EN, STRINGS, usedKeys } from './i18n-keys.mjs';

const LOCALES = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('every used key exists in every translated locale with matching placeholders', () => {
  const keys = usedKeys();
  assert.ok(keys.size > 180, 'key scan found ' + keys.size);
  const missing = [];
  for (const loc of LOCALES) {
    if (loc.startsWith('en-')) continue;
    for (const k of keys) {
      const v = STRINGS[loc][k];
      if (typeof v !== 'string' || !v) missing.push(loc + ': ' + k);
      else if (ph(v) !== ph(EN[k] ?? k)) missing.push(loc + ' placeholders: ' + k);
    }
  }
  assert.deepEqual(missing, []);
});

test('nine locales; the engine client lists the same', () => {
  assert.deepEqual(Object.keys(STRINGS).sort(), [...LOCALES].sort());
  const src = readFileSync(new URL('../native/i18n.ts', import.meta.url), 'utf8');
  for (const l of LOCALES) assert.ok(src.includes(`"${l}"`), l);
});
