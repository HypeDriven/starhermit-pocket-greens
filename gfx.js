'use strict';
(function () {

// Pocket Greens — graphics quality model: presets, per-category overrides, StarHermit hardware-level
// detection, per-preset budgets and a cost summary. Pure (no three.js), so the settings panel, the renderer and the unit tests
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

// Auto picks the preset from the StarHermit hardware level (0 = Galaxy S20 / Intel UHD or weaker, 20 = RTX
// 5090; gpu-level.js → window.StarHermitGpu, a classic script loaded before the game): Low from 0,
// Balanced from 4, High from 10, Ultra from 17. Phones, tablets and ≤ 4 GB machines are capped at level 9.
const LEVELS = { low: 0, balanced: 4, high: 10, ultra: 17 };
const gpuApi = () => (typeof globalThis !== 'undefined' ? globalThis.StarHermitGpu : undefined);

/** Hardware level 0–20 for an unmasked renderer string plus StarHermitGpu.detectSystem() facts. */
function detectLevel(gpu, system) {
	const G = gpuApi();
	const sys = { webgl: true, webgl2: true, ...(system || {}), gpu: String(gpu || '') };
	if (!gpu) sys.webgl = false; // no renderer string: no usable WebGL
	return G ? G.detectLevel(sys) : (gpu ? LEVELS.balanced : 0);
}

/** The preset Auto starts from for a hardware level. */
function presetForLevel(level) {
	const G = gpuApi();
	return G ? G.presetForLevel(level, LEVELS) : PRESETS.filter((p) => LEVELS[p] <= level).pop() || 'low';
}

/** Best preset for this GPU (the hardware level already caps phones/tablets at Balanced). */
function detectPreset(gpu, system) {
	return presetForLevel(detectLevel(gpu, system));
}

/*
 * Per-preset asset and effect budget. Each preset holds 60 FPS on the weakest GPU Auto gives it (Low →
 * level 0, Balanced → 4, High → 10, Ultra → 17; measured with tests/gfx-bench.mjs). Gameplay, layout and
 * hit areas are identical on every preset — only visuals change.
 *   material  course shading: lambert (Low) / standard (Balanced) / standard + clear-coated physical
 *             balls (High, Ultra; Scenery detailed)
 *   texScale  procedural textures (mowing stripes 256 px, noise / wood grain 128 px) × size
 *   foliage   flower and grass-tuft density around the course (Scenery detailed)
 *   hedge     hedge bush icosahedron detail (Scenery detailed)
 *   sparks    particle pool at Particles high (low: ≤ 64), scaled with the level
 *   pollen    drifting pollen motes (Particles high), scaled with the level
 *   bloomRes / aoRes  bloom and GTAO resolution as a fraction of the frame
 */
const BUDGETS = {
	low: { material: 'lambert', texScale: 0.5, foliage: 0.4, hedge: 1, sparks: 256, pollen: 20, bloomRes: 0.5, aoRes: 0.5 },
	balanced: { material: 'standard', texScale: 1, foliage: 0.6, hedge: 1, sparks: 512, pollen: 30, bloomRes: 0.5, aoRes: 0.5 },
	high: { material: 'physical', texScale: 1, foliage: 1, hedge: 2, sparks: 1024, pollen: 40, bloomRes: 0.5, aoRes: 0.5 },
	ultra: { material: 'physical', texScale: 2, foliage: 1.5, hedge: 2, sparks: 1536, pollen: 80, bloomRes: 1, aoRes: 1 },
};

/** A preset's concrete budget for a hardware level (effect counts scale ≤ 2× within the preset). */
function budgetFor(preset, level) {
	const b = { ...(BUDGETS[preset] || BUDGETS.balanced) };
	const G = gpuApi(), floor = LEVELS[preset] || 0;
	const lv = Math.max(Number.isFinite(level) ? level : floor, floor);
	const k = G ? Math.min(2, G.scaleBudget(1, lv, floor)) : 1;
	b.sparks = Math.min(SPARK_MAX, Math.round(b.sparks * k));
	b.pollen = Math.min(POLLEN_MAX, Math.round(b.pollen * k));
	return b;
}

const SPARK_MAX = 3072;
const POLLEN_MAX = 160;

/**
 * Resolve saved settings into concrete tiers.
 * `saved`: { preset: 'auto'|preset, render_scale, adaptive, show_fps, <category>: 'preset'|tier }.
 */
function resolve(saved, detected, level) {
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
	out.level = Number.isFinite(level) ? level : LEVELS[preset];
	out.budget = budgetFor(preset, out.level);
	out.particleBudget = out.particles === 'high' ? out.budget.sparks : Math.min(PARTICLE_BUDGET.low, out.budget.sparks);
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

const api = { PRESETS, CATEGORIES, SHADOW_MAP, PARTICLE_BUDGET, LEVELS, BUDGETS, SPARK_MAX, POLLEN_MAX, detectLevel, presetForLevel, budgetFor, detectPreset, resolve, presetTier, choosePreset, fromLegacyTier, describe };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else { window.PG = window.PG || {}; window.PG.gfx = api; }
})();
