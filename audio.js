'use strict';
(function () {

// Pocket Greens — audio: buses, event mapping, focus/background behavior, memory policy.
// Each event prefers an authored one-shot sample (sfx/<name>.opus, see sfx/manifest.json),
// fetched and decoded lazily after the user-gesture unlock; original short synthesized
// transients remain as the fallback while a clip loads or if it fails. Randomized pitch
// variants are seeded so replays sound identical for a given seed.

const RULES = (typeof module !== 'undefined' && module.exports) ? require('./rules') : window.PG.rules;

const BUS = ['music', 'effects', 'ambience', 'voice'];

let ctx = null;
let buses = null;
let volumes = { music: 0.6, effects: 0.9, ambience: 0.5, voice: 0.8 };
let muted = false;
let captionSink = null; // function(text) for accessibility captions of meaningful audio
let ambienceNodes = null;
let seedFn = RULES.mulberry32(1234);

function ensureContext() {
	if (ctx) return true;
	const AC = (typeof window !== 'undefined') && (window.AudioContext || window.webkitAudioContext);
	if (!AC) return false;
	ctx = new AC();
	buses = {};
	for (const b of BUS) {
		const g = ctx.createGain();
		g.gain.value = muted ? 0 : volumes[b];
		g.connect(ctx.destination);
		buses[b] = g;
	}
	return true;
}

function resume() {
	if (!ensureContext()) return false;
	if (ctx.state === 'suspended') ctx.resume();
	return true;
}

function setVolume(bus, v) {
	volumes[bus] = Math.max(0, Math.min(1, v));
	if (buses && buses[bus]) buses[bus].gain.value = muted ? 0 : volumes[bus];
}

function setMuted(m) {
	muted = !!m;
	if (buses) for (const b of BUS) buses[b].gain.value = muted ? 0 : volumes[b];
}

function setSeed(seed) { seedFn = RULES.mulberry32(RULES.hashStr('snd:' + seed)); }
function onCaption(fn) { captionSink = fn; }
function caption(text) { if (captionSink) captionSink(text); }

// One short synthesized transient: oscillator with an exponential envelope, plus an
// optional noise burst for material impacts.
function blip(bus, opts) {
	if (!ctx || muted) return;
	const t0 = ctx.currentTime + (opts.delay || 0);
	const osc = ctx.createOscillator();
	osc.type = opts.type || 'sine';
	osc.frequency.setValueAtTime(opts.freq || 440, t0);
	if (opts.slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, opts.slide), t0 + (opts.dur || 0.15));
	const g = ctx.createGain();
	const peak = opts.gain || 0.25;
	g.gain.setValueAtTime(0.0001, t0);
	g.gain.exponentialRampToValueAtTime(peak, t0 + 0.008);
	g.gain.exponentialRampToValueAtTime(0.0001, t0 + (opts.dur || 0.15));
	osc.connect(g).connect(buses[bus]);
	osc.start(t0);
	osc.stop(t0 + (opts.dur || 0.15) + 0.05);
	if (opts.noise) {
		const len = Math.floor(ctx.sampleRate * (opts.noiseDur || 0.06));
		const buf = ctx.createBuffer(1, len, ctx.sampleRate);
		const d = buf.getChannelData(0);
		for (let i = 0; i < len; i++) d[i] = (seedFn() * 2 - 1) * (1 - i / len);
		const src = ctx.createBufferSource();
		src.buffer = buf;
		const ng = ctx.createGain();
		ng.gain.value = opts.noiseGain || 0.15;
		const filt = ctx.createBiquadFilter();
		filt.type = 'bandpass';
		filt.frequency.value = opts.noiseFreq || 1200;
		src.connect(filt).connect(ng).connect(buses[bus]);
		src.start(t0);
	}
}

// Authored sample one-shots (sfx/manifest.json). Event type -> clip basename; a function
// picks a variant from the event payload. Clips are fetched/decoded lazily on first use
// and cached per basename: AudioBuffer while ready, Promise while loading, null on failure.
const SFX_MAP = {
	'ui': 'ui-click',
	'aim-tick': 'aim-tick',
	'invalid': 'invalid-buzz',
	'strike': (e) => (e.power != null && e.power >= 66) ? 'strike-hard' : 'strike-soft',
	'bounce': (e) => e.material === 'wall' ? 'bounce-wall' : e.material === 'mover' ? 'bounce-mover' : 'bounce-turf',
	'splash': 'splash',
	'holed': 'holed',
	'capped': 'capped',
	'round-complete': 'round-complete',
	'session-complete': 'session-complete',
	'undo': 'undo',
};
const sfxCache = {};

function requestSample(name) {
	if (name in sfxCache) return;
	if (typeof fetch !== 'function') { sfxCache[name] = null; return; }
	sfxCache[name] = fetch('sfx/' + name + '.opus')
		.then((r) => { if (!r.ok) throw new Error('http ' + r.status); return r.arrayBuffer(); })
		.then((ab) => ctx.decodeAudioData(ab))
		.then((buf) => { sfxCache[name] = buf; })
		.catch(() => { sfxCache[name] = null; });
}

// Play a cached clip once through the effects bus; false while loading or after failure.
function playSample(name) {
	const entry = sfxCache[name];
	if (!entry || typeof entry.then === 'function') return false;
	const src = ctx.createBufferSource();
	src.buffer = entry;
	src.connect(buses.effects);
	src.start();
	return true;
}

// Logical event -> sound mapping. Event hierarchy: ack < move < goal < round completion.
function event(e, opts) {
	opts = opts || {};
	if (!ctx) return;
	const mapped = SFX_MAP[e.type];
	const sampleName = typeof mapped === 'function' ? mapped(e) : mapped;
	let sampled = false;
	if (sampleName) {
		sampled = playSample(sampleName);
		if (!sampled) requestSample(sampleName); // synthesis covers this play; clip ready next time
	}
	const variant = 0.92 + seedFn() * 0.16; // seeded pitch variant
	switch (e.type) {
		case 'ui': if (!sampled) blip('effects', { freq: 660 * variant, dur: 0.06, gain: 0.12 }); break;
		case 'aim-tick': if (!sampled) blip('effects', { freq: 880 * variant, dur: 0.03, gain: 0.05 }); break;
		case 'invalid': if (!sampled) blip('effects', { freq: 180, dur: 0.12, type: 'square', gain: 0.1 }); caption('Invalid action: ' + (e.reason || '')); break;
		case 'strike':
			if (!sampled) blip('effects', { freq: 220 * variant, slide: 90, dur: 0.14, gain: 0.3, noise: true, noiseFreq: 900, noiseGain: 0.2 });
			caption('Stroke ' + (e.power != null ? Math.round(e.power) + '% power' : ''));
			break;
		case 'bounce': {
			if (!sampled) {
				const f = e.material === 'wall' ? 320 : e.material === 'mover' ? 260 : 380;
				blip('effects', { freq: f * variant, dur: 0.08, gain: 0.16, noise: true, noiseFreq: e.material === 'wall' ? 1600 : 700 });
			}
			break;
		}
		case 'splash':
			if (!sampled) blip('effects', { freq: 300, slide: 120, dur: 0.3, gain: 0.25, noise: true, noiseFreq: 500, noiseDur: 0.25, noiseGain: 0.3 });
			caption('Splash — penalty stroke');
			break;
		case 'holed':
			if (!sampled) {
				blip('effects', { freq: 523, dur: 0.12, gain: 0.2 });
				blip('effects', { freq: 659, dur: 0.12, gain: 0.2, delay: 0.1 });
				blip('effects', { freq: 784, dur: 0.25, gain: 0.24, delay: 0.2 });
			}
			caption('Holed in ' + (e.strokes || '?') + ' (par ' + (e.par || '?') + ')');
			break;
		case 'capped': if (!sampled) blip('effects', { freq: 240, slide: 160, dur: 0.3, gain: 0.18 }); caption('Stroke cap reached'); break;
		case 'round-complete':
			if (!sampled) [523, 659, 784, 1047].forEach((f, i) => blip('music', { freq: f, dur: 0.3, gain: 0.2, delay: i * 0.14, type: 'triangle' }));
			caption('Round complete');
			break;
		case 'session-complete':
			if (!sampled) [392, 523, 659, 784, 1047].forEach((f, i) => blip('music', { freq: f, dur: 0.35, gain: 0.22, delay: i * 0.15, type: 'triangle' }));
			caption('Session results ready');
			break;
		case 'undo': if (!sampled) blip('effects', { freq: 500, slide: 700, dur: 0.1, gain: 0.12 }); caption('Undone'); break;
	}
}

// Quiet synthesized ambience bed per theme; paused when the tab is hidden.
function startAmbience(kind) {
	if (!ctx || ambienceNodes) return;
	const g = ctx.createGain();
	g.gain.value = 0.05;
	g.connect(buses.ambience);
	const osc = ctx.createOscillator();
	osc.type = 'sine';
	osc.frequency.value = kind === 'dusk' ? 110 : kind === 'frost' ? 196 : 147;
	const lfo = ctx.createOscillator();
	lfo.frequency.value = kind === 'water' || kind === 'pond' ? 0.4 : 0.18;
	const lfoG = ctx.createGain();
	lfoG.gain.value = 0.025;
	lfo.connect(lfoG).connect(g.gain);
	osc.connect(g);
	osc.start(); lfo.start();
	ambienceNodes = { osc, lfo, g };
}

function stopAmbience() {
	if (!ambienceNodes) return;
	try { ambienceNodes.osc.stop(); ambienceNodes.lfo.stop(); } catch (e) { /* already stopped */ }
	ambienceNodes.g.disconnect();
	ambienceNodes = null;
}

// Background tabs: suspend rendering of sound to a heartbeat but keep context alive.
function setBackgrounded(hidden) {
	if (!ctx) return;
	if (hidden) { stopAmbience(); } else { resume(); }
}

const api = {
	BUS, resume, ensureContext, setVolume, setMuted, setSeed, onCaption, event,
	startAmbience, stopAmbience, setBackgrounded,
	get volumes() { return Object.assign({}, volumes); },
	get muted() { return muted; },
	get ready() { return !!ctx; },
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
else { window.PG = window.PG || {}; window.PG.audio = api; }
})();
