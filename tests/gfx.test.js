'use strict';
// Unit tests for the pure graphics quality model (gfx.js) and its localized strings.
const test = require('node:test');
const assert = require('node:assert');
// gpu-level.js is a classic script in the page (window.StarHermitGpu); load it the same way here.
globalThis.StarHermitGpu = require('../gpu-level');
const GFX = require('../gfx');
const { PRESETS, LEVELS, BUDGETS, detectPreset, detectLevel, presetForLevel, budgetFor, resolve } = GFX;
const I18N = require('../gfx-i18n');

const DESK = { cores: 8, memoryGb: 8 };
const PHONE = { mobile: true, cores: 8, memoryGb: 8 };

test('hardware level picks the Auto preset (Low 0, Balanced 4, High 10, Ultra 17)', () => {
	assert.equal(detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', DESK), 'low');
	assert.equal(detectLevel('llvmpipe (LLVM 15.0.7, 256 bits)', DESK), 0);
	assert.equal(detectPreset('', DESK), 'low', 'no WebGL');
	assert.equal(detectPreset('ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', DESK), 'low');
	assert.equal(detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)', DESK), 'low');
	assert.equal(detectPreset('ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11)', DESK), 'balanced');
	assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce GTX 1070 Direct3D11 vs_5_0 ps_5_0)', DESK), 'high');
	assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 Direct3D11 vs_5_0 ps_5_0)', DESK), 'ultra');
	assert.equal(detectLevel('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)', DESK), 20);
	assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)', DESK), 'ultra');
	for (const [p, lv] of Object.entries(LEVELS)) assert.equal(presetForLevel(lv), p);
	assert.equal(presetForLevel(3), 'low');
	assert.equal(presetForLevel(16), 'high');
});

test('phones and tablets are Balanced at most; software GPUs stay Low', () => {
	assert.equal(detectPreset('Adreno (TM) 740', PHONE), 'balanced');
	assert.ok(detectLevel('Adreno (TM) 740', PHONE) <= 9);
	assert.equal(detectPreset('Apple M2', PHONE), 'balanced');
	assert.equal(detectPreset('SwiftShader', PHONE), 'low');
});

test('per-preset budgets are explicit, grow from Low to Ultra and scale with the level', () => {
	const keys = ['material', 'texScale', 'foliage', 'hedge', 'sparks', 'pollen', 'bloomRes', 'aoRes'];
	for (const p of PRESETS) for (const k of keys) assert.ok(BUDGETS[p][k] != null, `${p}.${k}`);
	for (let i = 1; i < PRESETS.length; i++) for (const k of keys) {
	  if (typeof BUDGETS.low[k] === 'number') assert.ok(BUDGETS[PRESETS[i]][k] >= BUDGETS[PRESETS[i - 1]][k], `${PRESETS[i]}.${k}`);
	}
	assert.deepEqual(PRESETS.map((p) => BUDGETS[p].material), ['lambert', 'standard', 'physical', 'physical']);
	assert.deepEqual(PRESETS.map((p) => BUDGETS[p].bloomRes), [0.5, 0.5, 0.5, 1], 'half-res bloom below Ultra');
	assert.deepEqual(resolve({ preset: 'high' }, 'low', 10).budget, BUDGETS.high, 'floor level = the tuned budget');
	assert.deepEqual(resolve({ preset: 'ultra' }, 'low', 0).budget, resolve({ preset: 'ultra' }, 'ultra', 17).budget);
	assert.ok(budgetFor('balanced', 9).pollen > budgetFor('balanced', 4).pollen, 'counts scale up within the preset');
	assert.ok(budgetFor('ultra', 20).sparks <= GFX.SPARK_MAX && budgetFor('ultra', 20).pollen <= GFX.POLLEN_MAX);
	assert.equal(resolve({ preset: 'high' }, 'low', 10).particleBudget, 1024);
	assert.equal(resolve({ preset: 'low' }, 'low', 0).particleBudget, 64, 'Low: particles low');
	assert.equal(resolve({}, 'low', 0).budget.material, 'lambert', 'headless SwiftShader: Low, Lambert');
});

test('resolve: auto follows the detected preset', () => {
	const r = GFX.resolve({ preset: 'auto' }, 'low');
	assert.strictEqual(r.preset, 'low');
	assert.strictEqual(r.auto, true);
	assert.strictEqual(r.shadows, 'off');
	assert.strictEqual(r.post, false); // Low renders without post-processing
	assert.strictEqual(r.dprCap, 1);
	assert.strictEqual(GFX.resolve({}, undefined).preset, 'balanced');
});

test('resolve: explicit preset, overrides and invalid values', () => {
	const r = GFX.resolve({ preset: 'high', bloom: 'off', shadows: 'bogus', water: 'static' }, 'low');
	assert.strictEqual(r.preset, 'high');
	assert.strictEqual(r.auto, false);
	assert.strictEqual(r.bloom, 'off');
	assert.strictEqual(r.shadows, GFX.presetTier('high', 'shadows'));
	assert.strictEqual(r.water, 'static');
	assert.strictEqual(r.shadowMap, 2048);
	assert.strictEqual(r.post, true);
	const low = GFX.resolve({ preset: 'low', ao: 'on' }, 'high');
	assert.strictEqual(low.post, true, 'an override that needs post-processing turns the chain on');
});

test('resolve: render scale is clamped to 50–200%', () => {
	assert.strictEqual(GFX.resolve({ preset: 'high', render_scale: 5 }).renderScale, 2);
	assert.strictEqual(GFX.resolve({ preset: 'high', render_scale: 0.1 }).renderScale, 0.5);
	assert.strictEqual(GFX.resolve({ preset: 'ultra', render_scale: 1 }).scale, 1.25);
	assert.strictEqual(GFX.resolve({ preset: 'low' }).scale, 0.75);
	assert.strictEqual(GFX.resolve({ preset: 'high' }).adaptive, true);
	assert.strictEqual(GFX.resolve({ preset: 'high', adaptive: false, show_fps: true }).showFps, true);
});

test('choosing a preset clears per-category overrides', () => {
	const s = GFX.choosePreset({ preset: 'high', bloom: 'off', ao: 'high', render_scale: 1.5, show_fps: true }, 'low');
	assert.strictEqual(s.preset, 'low');
	assert.ok(!('bloom' in s) && !('ao' in s));
	assert.strictEqual(s.render_scale, 1.5);
	assert.strictEqual(s.show_fps, true);
	assert.strictEqual(GFX.choosePreset({}, 'nonsense').preset, 'auto');
});

test('legacy quality tier migrates onto a preset', () => {
	assert.strictEqual(GFX.fromLegacyTier('low'), 'low');
	assert.strictEqual(GFX.fromLegacyTier('medium'), 'balanced');
	assert.strictEqual(GFX.fromLegacyTier('high'), 'high');
	assert.strictEqual(GFX.fromLegacyTier('auto'), 'auto');
});

test('describe summarises cost', () => {
	const d = GFX.describe(GFX.resolve({ preset: 'high' }), [1280, 720]);
	assert.match(d, /2048² shadows/);
	assert.match(d, /SMAA/);
	assert.match(d, /1280×720 px/);
	assert.match(GFX.describe(GFX.resolve({ preset: 'low', antialias: 'off' })), /no shadows · no anti-aliasing/);
});

test('every locale has every graphics string', () => {
	const want = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
	const base = I18N.STRINGS['en-US'];
	for (const loc of want) {
		const s = I18N.STRINGS[loc];
		assert.ok(s, loc);
		for (const k of Object.keys(base)) {
			assert.ok(s[k], loc + ' ' + k);
			if (typeof base[k] === 'object') for (const kk of Object.keys(base[k])) assert.ok(s[k][kk], loc + ' ' + k + '.' + kk);
		}
		for (const cat of Object.keys(GFX.CATEGORIES)) {
			assert.ok(s.cat[cat], loc + ' cat ' + cat);
			for (const tier of GFX.CATEGORIES[cat]) assert.ok(s.tier[tier], loc + ' tier ' + tier);
		}
	}
	assert.strictEqual(I18N.pickLocale('es-MX'), 'es-419');
	assert.strictEqual(I18N.pickLocale('en-AU'), 'en-GB');
	assert.strictEqual(I18N.pickLocale('fr-BE'), 'fr-FR');
	assert.strictEqual(I18N.pickLocale('ja-JP'), 'en-US');
});

test('graphics summary level label in every locale', () => {
	for (const loc of I18N.LOCALES) assert.match(I18N.STRINGS[loc].level.replace('{n}', 7), /7$/, loc);
});
