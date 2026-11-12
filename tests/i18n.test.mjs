// Every player-facing key the engine client uses (tests/i18n-keys.mjs) exists in all nine
// locales with the same {placeholders}.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EN, STRINGS, usedKeys } from './i18n-keys.mjs';

const LOCALES = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT', 'fr-BE', 'de-BE', 'en-SG', 'en-HK', 'en-BQ', 'es-CO', 'de-IT', 'fr-IT', 'es-CL', 'es-AR', 'es-EC', 'nl-BE', 'zh-SG', 'ms-SG', 'zh-HK', 'yue-HK', 'nl-NL', 'fi-FI', 'sv-FI', 'et-EE', 'id-ID', 'ta-SG', 'de-BR', 'vi-VN', 'ja-JP', 'lb-BE', 'eu-FR', 'oc-FR', 'sl-IT', 'oc-IT', 'ru-FI', 'eu-ES', 'gl-ES', 'ru-EE', 'su-ID', 'km-VN', 'da-DE', 'co-FR', 'ca-FR', 'fur-IT', 'ca-IT', 'ca-ES', 'bew-ID'];
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

test('nine locales', () => {
  assert.deepEqual(Object.keys(STRINGS).sort(), [...LOCALES].sort());
});
