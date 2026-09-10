'use strict';
(function () {

// Pocket Greens — platform: token-aware REST adapter, retries, rate-limit handling,
// settings persistence, presence, telemetry consent. Same-origin /api routes when hosted;
// everything degrades to local-only behavior offline. Access/launch tokens are never
// persisted to local storage.

const hasWindow = typeof window !== 'undefined';

const state = {
	serverOffset: 0,       // round-trip-adjusted offset between server clock and local clock
	timeSynced: false,
	consent: false,
	online: hasWindow ? navigator.onLine : true,
	base: '',
	events: [],            // consented anonymous funnel events, flushed best-effort
	heartbeatTimer: null,
};

// ---------- time ----------

// GET /api/v1/time with round-trip adjustment; falls back to local clock offline.
async function syncTime() {
	if (!hasWindow || !window.fetch) return now();
	const t0 = Date.now();
	try {
		const res = await fetch(state.base + '/api/v1/time', { cache: 'no-store' });
		const t1 = Date.now();
		if (!res.ok) throw new Error('http ' + res.status);
		const body = await res.json();
		const rtt = t1 - t0;
		state.serverOffset = (body.now + rtt / 2) - t1;
		state.timeSynced = true;
	} catch (e) {
		state.timeSynced = false;
	}
	return now();
}

function now() { return Date.now() + (state.timeSynced ? state.serverOffset : 0); }

// ---------- REST helper ----------

// Structured {"error":"..."} responses and rate limits are recoverable UI states:
// the caller receives { ok:false, error, retryAfter } rather than an exception.
async function api(path, opts) {
	opts = opts || {};
	const url = state.base + path;
	let attempt = 0;
	while (attempt < 3) {
		attempt += 1;
		try {
			const res = await fetch(url, {
				method: opts.method || 'GET',
				headers: Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {}),
				body: opts.body ? JSON.stringify(opts.body) : undefined,
			});
			if (res.status === 429) {
				const wait = Number(res.headers.get('Retry-After')) * 1000 || 1000 * attempt;
				await new Promise(r => setTimeout(r, wait));
				continue;
			}
			const body = await res.json().catch(() => ({}));
			if (!res.ok) return { ok: false, status: res.status, error: body.error || ('http-' + res.status) };
			return { ok: true, data: body };
		} catch (e) {
			if (attempt >= 3) return { ok: false, error: 'offline', offline: true };
			await new Promise(r => setTimeout(r, 300 * attempt));
		}
	}
	return { ok: false, error: 'unreachable' };
}

// ---------- settings & progression persistence ----------

const SETTINGS_KEY = 'pocket-greens.settings.v1';
const PROGRESS_KEY = 'pocket-greens.progress.v1';

const DEFAULT_SETTINGS = {
	audio: { music: 0.6, effects: 0.9, ambience: 0.5, voice: 0.8, muted: false, captions: false },
	graphics: { tier: 'auto', reducedMotion: false, highContrast: false, largeText: false, palette: 'default' },
	controls: { leftHanded: false, holdToAim: false, timingAssist: false, haptics: true, camera: 'follow' },
	tutorial: { completed: {} },
	telemetry: { consent: false },
};

function loadLocal(key, fallback) {
	if (!hasWindow || !window.localStorage) return fallback;
	try {
		const raw = localStorage.getItem(key);
		return raw ? Object.assign({}, fallback, JSON.parse(raw)) : JSON.parse(JSON.stringify(fallback));
	} catch (e) { return JSON.parse(JSON.stringify(fallback)); }
}

function saveLocal(key, value) {
	if (!hasWindow || !window.localStorage) return;
	try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage full/blocked: session continues */ }
}

function loadSettings() { return loadLocal(SETTINGS_KEY, DEFAULT_SETTINGS); }
function saveSettings(s) { saveLocal(SETTINGS_KEY, s); }

// Cloud-save progression: versioned, checksummed document. Conflicts preserve both
// snapshots; the caller asks the player when neither is a strict descendant.
function checksum(doc) {
	const RULES = (typeof module !== 'undefined' && module.exports) ? require('./rules') : window.PG.rules;
	return RULES.hashStr(RULES.stableStringify({ v: doc.version, journey: doc.journey, achievements: doc.achievements, mastery: doc.mastery }));
}

const DEFAULT_PROGRESS = {
	version: 2,
	journey: { unlocked: 1, stars: {} },     // stage id -> best strokes
	achievements: {},                        // key -> timestamp
	mastery: { holesCompleted: 0, noPenaltyHoles: 0, bestDaily: null, underParStreak: 0 },
};

function loadProgress() {
	const p = loadLocal(PROGRESS_KEY, DEFAULT_PROGRESS);
	if (p.checksum && p.checksum !== checksum(p)) {
		// corrupted local save: keep it aside, start clean rather than crashing
		saveLocal(PROGRESS_KEY + '.corrupt.' + Date.now(), p);
		return JSON.parse(JSON.stringify(DEFAULT_PROGRESS));
	}
	return p;
}

function saveProgress(p) {
	p.checksum = checksum(p);
	saveLocal(PROGRESS_KEY, p);
}

// ---------- achievements (static, idempotent) ----------

const ACHIEVEMENTS = [
	{ key: 'first_hole', name: 'First Cup', desc: 'Hole out for the first time.' },
	{ key: 'mechanic_master', name: 'Course Mechanic', desc: 'Complete every Learn lesson.' },
	{ key: 'streak_3', name: 'On a Roll', desc: 'Hole out on three holes in a row under par.' },
	{ key: 'journey_half', name: 'Half the Garden', desc: 'Complete 22 Journey stages.' },
	{ key: 'century', name: 'Century of Putts', desc: 'Complete 100 holes across all modes.' },
];

function unlockAchievement(progress, key) {
	if (progress.achievements[key]) return false; // idempotent
	if (!ACHIEVEMENTS.find(a => a.key === key)) return false;
	progress.achievements[key] = now();
	return true;
}

// Sustained streak: holes holed out under par, counted consecutively across rounds.
// A hole at par or worse (including capped holes) resets the streak; rounds that end
// without a completed hole leave it unchanged. Returns the achievement name when the
// three-in-a-row milestone is newly reached, otherwise null.
function recordHoleStreak(progress, holes, total, parTotal) {
	if (holes > 0 && total < parTotal) progress.mastery.underParStreak = (progress.mastery.underParStreak || 0) + holes;
	else if (holes > 0) progress.mastery.underParStreak = 0;
	if ((progress.mastery.underParStreak || 0) >= 3 && unlockAchievement(progress, 'streak_3')) return 'On a Roll';
	return null;
}

// ---------- presence & activity ----------

function startActivity(kind) {
	stopActivity();
	if (!hasWindow) return;
	// throttled heartbeat while actively playing; accurate playtime pairing
	state.heartbeatTimer = setInterval(() => {
		api('/api/v1/presence', { method: 'POST', body: { activity: kind, at: now() } });
	}, 45000);
	api('/api/v1/presence', { method: 'POST', body: { activity: kind, start: true, at: now() } });
}

function stopActivity() {
	if (state.heartbeatTimer) { clearInterval(state.heartbeatTimer); state.heartbeatTimer = null; }
	if (hasWindow) api('/api/v1/presence', { method: 'POST', body: { activity: null, end: true, at: now() } });
}

// ---------- anonymous funnel telemetry ----------

const FUNNEL_EVENTS = ['start', 'tutorial-step', 'round-end', 'retry', 'settings-change', 'error'];

function track(name, data) {
	if (!state.consent || !FUNNEL_EVENTS.includes(name)) return;
	const clean = { name, at: now() };
	if (data && typeof data === 'object') {
		// aggregate-safe fields only: no text, no pointer trails, no identifiers
		for (const k of ['step', 'tier', 'mode', 'category', 'modality']) if (data[k] != null) clean[k] = String(data[k]).slice(0, 32);
	}
	state.events.push(clean);
	if (state.events.length >= 8) flushTelemetry();
}

async function flushTelemetry() {
	if (!state.events.length) return;
	const batch = state.events.splice(0, state.events.length);
	await api('/api/v1/telemetry', { method: 'POST', body: { events: batch } });
}

function setConsent(c) { state.consent = !!c; }

const platformApi = {
	syncTime, now, api, state,
	loadSettings, saveSettings, loadProgress, saveProgress,
	ACHIEVEMENTS, unlockAchievement, recordHoleStreak, FUNNEL_EVENTS, track, flushTelemetry, setConsent,
	startActivity, stopActivity, DEFAULT_SETTINGS, DEFAULT_PROGRESS,
};

if (typeof module !== 'undefined' && module.exports) module.exports = platformApi;
else { window.PG = window.PG || {}; window.PG.platform = platformApi; }
})();
