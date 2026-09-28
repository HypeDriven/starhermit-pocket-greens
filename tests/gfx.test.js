'use strict';
// Unit tests for the pure graphics quality model (gfx.js) and its localized strings.
const test = require('node:test');
const assert = require('node:assert');
const GFX = require('../gfx');
const I18N = require('../gfx-i18n');

test('detectPreset maps GPU strings to presets', () => {
	assert.strictEqual(GFX.detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)'), 'low');
	assert.strictEqual(GFX.detectPreset('llvmpipe (LLVM 15.0.7, 256 bits)'), 'low');
	assert.strictEqual(GFX.detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0)'), 'high');
	assert.strictEqual(GFX.detectPreset('Apple M2 Pro'), 'high');
	assert.strictEqual(GFX.detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)'), 'balanced');
	assert.strictEqual(GFX.detectPreset('Adreno (TM) 740'), 'balanced');
	assert.strictEqual(GFX.detectPreset(''), 'balanced');
	// touch/mobile devices cap Auto at Balanced
	assert.strictEqual(GFX.detectPreset('Apple M1', true), 'balanced');
	assert.strictEqual(GFX.detectPreset('SwiftShader', true), 'low');
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
