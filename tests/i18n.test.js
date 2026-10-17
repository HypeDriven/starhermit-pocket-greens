'use strict';
// Every player-facing key used in markup (index.html data-i18n*), code
// (bootstrap.js / ui.js / audio.js) and content (tutorials, challenges,
// achievements, rule and challenge reasons) exists in all nine locales with the
// same {placeholders}. DUMP=1 lists the keys.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { STRINGS, EN } = require('../strings.js');
const CONTENT = require('../content.js');

const LOCALES = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const lit = /'((?:[^'\\]|\\.)*)'/.source;
const all = (src, re, keys, groups = [1]) => { for (const m of src.matchAll(re)) for (const g of groups) if (m[g] != null) keys.add(m[g].replace(/\\'/g, "'")); };

function usedKeys() {
	const keys = new Set();
	for (const m of read('index.html').matchAll(/data-i18n(?:-aria|-title)?="([^"]*)"/g)) keys.add(unescape(m[1]));
	const boot = read('bootstrap.js'), ui = read('ui.js'), audio = read('audio.js');
	for (const src of [boot, ui]) {
		all(src, new RegExp(`\\bT\\(${lit}`, 'g'), keys);
		all(src, new RegExp(`\\bT\\([^()]*?\\?\\s*${lit}\\s*:\\s*${lit}`, 'g'), keys, [1, 2]);
	}
	all(audio, new RegExp(`\\btr\\(${lit}`, 'g'), keys);
	all(ui, new RegExp(`settingRow\\(${lit}`, 'g'), keys);
	all(ui, new RegExp(`H3\\(${lit}`, 'g'), keys);
	all(boot.slice(boot.indexOf('const m = { learn'), boot.indexOf('return m[G.mode]')), new RegExp(`: ${lit}`, 'g'), keys);
	all(boot.slice(boot.indexOf('const key = {'), boot.indexOf('return key ? T(key)')), new RegExp(`: ${lit}`, 'g'), keys);
	all(boot, new RegExp(`\\? \\(r\\.challenge\\.status === 'passed' \\? ${lit} : ${lit}\\)\\s*: \\(mine\\.total <= parTotal \\? ${lit} : ${lit}\\)`, 'g'), keys, [1, 2, 3, 4]);
	all(boot, new RegExp(`unlocked\\.push\\(${lit}\\)`, 'g'), keys);
	all(read('platform.js'), new RegExp(`return ${lit};\\n\\treturn null;`, 'g'), keys); // streak achievement name
	for (const k of Object.keys(EN)) keys.add(k);
	for (const tut of CONTENT.TUTORIALS) { keys.add(tut.title); for (const st of tut.steps) keys.add(st.text); }
	for (const ch of CONTENT.CHALLENGES) { keys.add(ch.name); keys.add(ch.desc); }
	for (const k of [...keys]) if (k === '' || /^(reason|challenge|palette)\.$/.test(k)) keys.delete(k);
	return keys;
}

const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('every used key exists in every translated locale with matching placeholders', () => {
	const keys = usedKeys();
	if (process.env.DUMP) console.log([...keys].sort().map((k) => JSON.stringify(k)).join('\n'));
	assert.ok(keys.size > 150, 'key scan found ' + keys.size);
	const missing = [];
	for (const loc of LOCALES) {
		if (loc.startsWith('en-')) continue;
		for (const k of keys) {
			const v = STRINGS[loc][k];
			if (typeof v !== 'string' || !v) missing.push(loc + ': ' + k);
			else if (ph(v) !== ph(EN[k] != null ? EN[k] : k)) missing.push(loc + ' placeholders: ' + k);
		}
	}
	assert.deepEqual(missing, []);
});

test('nine locales; en-GB overrides only real keys; symbolic keys have en-US text', () => {
	assert.deepEqual(Object.keys(STRINGS).sort(), [...LOCALES].sort());
	const keys = usedKeys();
	for (const k of Object.keys(STRINGS['en-GB'])) assert.ok(keys.has(k), 'unknown en-GB key ' + k);
	for (const code of ['malformed-command', 'round-complete', 'not-awaiting-aim', 'out-of-turn', 'bad-stroke-params', 'power-out-of-range', 'transition-is-automatic', 'unknown-command']) assert.ok(EN['reason.' + code], 'reason.' + code);
	for (const code of ['penalty', 'stroke-limit', 'time-limit', 'no-bounce', 'power-limit']) assert.ok(EN['challenge.' + code], 'challenge.' + code);
	for (const p of ['default', 'deuteranopia', 'protanopia', 'tritanopia']) assert.ok(EN['palette.' + p], 'palette.' + p);
});

test('i18n.t fills placeholders and falls back to en-US', () => {
	const I = require('../i18n.js');
	assert.equal(I.t('Hole {n} — par {par}', { n: 2, par: 3 }), 'Hole 2 — par 3');
	I.setLocale('de-DE');
	assert.equal(I.locale, 'de-DE');
	assert.notEqual(I.t('Strike'), undefined);
	I.setLocale('xx');
	assert.equal(I.locale, 'en-US');
});
