// The player-facing keys the engine client uses: T("…") / T('…') literals in
// native/*.ts (both arms of `cond ? "a" : "b"` inside T()), N("…") marks,
// the symbolic EN keys, and the content's lessons, challenges and
// achievements. Shared by tests/i18n.test.mjs.
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const { STRINGS, EN } = require('../js/strings.js');
const CONTENT = require('../js/content.js');
const PROGRESS = require('../js/progress.js');

export function usedKeys() {
  const keys = new Set();
  const lit = /"((?:[^"\\]|\\.)*)"/.source;
  for (const f of readdirSync(join(root, 'native')).filter((n) => n.endsWith('.ts'))) {
    const src = readFileSync(join(root, 'native', f), 'utf8');
    for (const m of src.matchAll(new RegExp(`\\b[TN]\\(${lit}`, 'g'))) keys.add(m[1]);
    for (const m of src.matchAll(new RegExp(`\\bT\\([^()"]*\\?\\s*${lit}\\s*:\\s*${lit}`, 'g'))) { keys.add(m[1]); keys.add(m[2]); }
    // label tables: ({ key: "Text", … })[x] and "Text" headlines passed to T() later
    for (const m of src.matchAll(/\/\/ i18n: ([^\n]+)/g)) for (const k of m[1].split(' | ')) keys.add(k.trim());
  }
  for (const k of Object.keys(EN)) keys.add(k);
  for (const t of CONTENT.TUTORIALS) { keys.add(t.title); for (const s of t.steps) keys.add(s.text); }
  for (const c of CONTENT.CHALLENGES) { keys.add(c.name); keys.add(c.desc); }
  for (const a of PROGRESS.ACHIEVEMENTS) keys.add(a.name);
  for (const k of [...keys]) if (!k || /^(reason|challenge|palette)\.$/.test(k)) keys.delete(k);
  return keys;
}
