'use strict';
(function () {

// Pocket Greens — graphics quality model: presets, per-category overrides, GPU detection and a
// cost summary. Pure (no three.js), so the settings panel, the renderer and the unit tests
// agree on what a setting means. Tiers never alter rules, picking, or hazard visibility.

const PRESETS = ['low', 'balanced', 'high', 'ultra'];

// Category → allowed tiers, cheapest first.
const CATEGORIES = {
	shadows: ['off', 'low', 'medium', 'high'],
	ao: ['off', 'on', 'high'],
	bloom: ['off', 'on'],
	grade: ['off', 'on'],
	antialias: ['off', 'fxaa', 'smaa', 'msaa'],
	reflections: ['off', 'on'],
	water: ['static', 'animated'],
	particles: ['low', 'high'],
	detail: ['plain', 'detailed'],
};

// Each preset is a row of tiers, a render scale (multiplies the device pixel ratio) and a
// device-pixel-ratio cap. Low matches the game's original low tier (dpr ≤ 1 × 0.75, no
// shadows, no post-processing) so it is never more expensive than before.
const TABLE = {
	low: { scale: 0.75, dprCap: 1, shadows: 'off', ao: 'off', bloom: 'off', grade: 'off', antialias: 'msaa', reflections: 'off', water: 'static', particles: 'low', detail: 'plain' },
	balanced: { scale: 1, dprCap: 1.5, shadows: 'low', ao: 'off', bloom: 'on', grade: 'on', antialias: 'fxaa', reflections: 'on', water: 'animated', particles: 'high', detail: 'detailed' },
	high: { scale: 1, dprCap: 2, shadows: 'medium', ao: 'on', bloom: 'on', grade: 'on', antialias: 'smaa', reflections: 'on', water: 'animated', particles: 'high', detail: 'detailed' },
	ultra: { scale: 1.25, dprCap: 2, shadows: 'high', ao: 'high', bloom: 'on', grade: 'on', antialias: 'msaa', reflections: 'on', water: 'animated', particles: 'high', detail: 'detailed' },
};

const SHADOW_MAP = { off: 0, low: 1024, medium: 2048, high: 4096 };
const PARTICLE_BUDGET = { low: 64, high: 1024 };

/** Best preset for this GPU, from the unmasked renderer string when the browser exposes it. */
function detectPreset(gpu, mobile) {
	const g = String(gpu || '').toLowerCase();
	let p = 'balanced';
	if (/swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/.test(g)) p = 'low';
	else if (/nvidia|geforce|rtx|gtx|quadro|radeon rx|radeon pro|amd radeon(?!.*graphics)|apple m\d/.test(g)) p = 'high';
	// touch/mobile devices never auto-select above Balanced (heat and battery)
	if (mobile && (p === 'high' || p === 'ultra')) p = 'balanced';
	return p;
}

/**
 * Resolve saved settings into concrete tiers.
 * `saved`: { preset: 'auto'|preset, render_scale, adaptive, show_fps, <category>: 'preset'|tier }.
 */
function resolve(saved, detected) {
	const s = saved || {};
	const auto = !PRESETS.includes(s.preset);
	const preset = auto ? (PRESETS.includes(detected) ? detected : 'balanced') : s.preset;
	const row = TABLE[preset];
	const out = {
		preset, auto,
		renderScale: clamp(Number(s.render_scale) || 1, 0.5, 2),
		dprCap: row.dprCap,
	};
	out.scale = row.scale * out.renderScale;
	for (const cat of Object.keys(CATEGORIES)) {
		out[cat] = CATEGORIES[cat].includes(s[cat]) ? s[cat] : row[cat];
	}
	out.adaptive = s.adaptive !== false;
	out.showFps = !!s.show_fps;
	out.shadowMap = SHADOW_MAP[out.shadows];
	out.particleBudget = PARTICLE_BUDGET[out.particles];
	// Post-processing runs only when something needs it; otherwise the canvas renders directly
	// (with the canvas's own multisampling).
	out.post = out.ao !== 'off' || out.bloom === 'on' || out.grade === 'on' ||
		out.antialias === 'fxaa' || out.antialias === 'smaa';
	return out;
}

/** The preset's own tier for a category (for "From preset (…)" labels). */
function presetTier(preset, cat) {
	return TABLE[preset] ? TABLE[preset][cat] : undefined;
}

/** Choosing a preset clears every per-category override; scale/adaptive/fps are kept. */
function choosePreset(saved, preset) {
	const s = Object.assign({}, saved || {});
	for (const cat of Object.keys(CATEGORIES)) delete s[cat];
	s.preset = PRESETS.includes(preset) ? preset : 'auto';
	return s;
}

/** Map the legacy single "quality tier" setting onto a preset. */
function fromLegacyTier(tier) {
	return { low: 'low', medium: 'balanced', high: 'high' }[tier] || 'auto';
}

const EN = {
	noShadows: 'no shadows', shadows: '{n}² shadows', ao: 'ambient occlusion', aoHigh: 'full ambient occlusion',
	bloom: 'bloom', reflections: 'reflections', noAA: 'no anti-aliasing',
};

/** One-line cost summary. `t` optionally supplies localized fragments (same keys as EN). */
function describe(r, pixels, t) {
	const L = Object.assign({}, EN, t || {});
	const parts = [
		r.shadows === 'off' ? L.noShadows : L.shadows.replace('{n}', SHADOW_MAP[r.shadows]),
		r.ao === 'off' ? null : r.ao === 'high' ? L.aoHigh : L.ao,
		r.bloom === 'on' ? L.bloom : null,
		r.reflections === 'on' ? L.reflections : null,
		r.antialias === 'off' ? L.noAA : r.antialias.toUpperCase(),
		pixels ? pixels[0] + '×' + pixels[1] + ' px' : null,
	];
	return parts.filter(Boolean).join(' · ');
}

function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

const api = { PRESETS, CATEGORIES, SHADOW_MAP, PARTICLE_BUDGET, detectPreset, resolve, presetTier, choosePreset, fromLegacyTier, describe };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else { window.PG = window.PG || {}; window.PG.gfx = api; }
})();
