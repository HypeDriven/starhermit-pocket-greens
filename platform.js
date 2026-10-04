'use strict';
(function () {

// Pocket Greens — platform adapter over the shared StarHermit SDK (starhermit-sdk.js,
// loaded before this script): launch token + renewal, sign-in, account nickname, cloud
// save (slot game:<slug>; localStorage stays the offline cache), per-player settings KV,
// keyboard bindings and the invite link. Hosted mode is "the SDK holds a token"; every
// platform REST call then carries Bearer auth (through the SDK). Without a token no
// request is made at all: the game never calls its own server routes (/api, /ws), the
// device clock is authoritative and progress/achievements stay local. Tokens are never
// persisted.

const hasWindow = typeof window !== 'undefined';

/** The SDK instance (window.StarHermit; tests may inject one on globalThis). */
function sdk() { return (typeof globalThis !== 'undefined' && globalThis.StarHermit) || null; }
function hosted() { const sh = sdk(); return !!(sh && sh.signedIn); }

const state = {
	online: hasWindow ? navigator.onLine : true,
	sync: 'offline',       // cloud-save status: offline | saving | synced | error
	nickname: null,        // resolved account nickname (hosted only)
};
// Launch context comes from the SDK (memory only).
Object.defineProperties(state, {
	hosted: { enumerable: true, get: hosted },
	token: { enumerable: true, get: () => (hosted() ? sdk().token : null) },
	sub: { enumerable: true, get: () => (hosted() ? String(sdk().userId) : null) },
	slug: { enumerable: true, get: () => (hosted() ? sdk().slug : null) },
});

function initAuth() {
	const sh = sdk();
	if (!sh) return;
	if (!sh.signedIn) sh.init(); // no-op when index.html already read the token
	sh.on('saved', (ok) => {
		if (!ok) lastSavedJson = ''; // retry the same doc on the next checkpoint
		setSync(ok ? 'synced' : (state.online === false ? 'offline' : 'error'));
	});
	sh.on('auth', (a) => {
		if (!a.signedIn) { state.nickname = null; setSync('offline'); }
		if (platformApi.onAuth) platformApi.onAuth({ signedIn: !!a.signedIn });
		refreshIdentity();
	});
}

function canSignIn() { const sh = sdk(); return !!(sh && sh.canSignIn()); }
function signIn() { const sh = sdk(); return !!(sh && sh.signIn()); }
function inviteLink() { return hosted() ? sdk().inviteLink() : null; }

// ---------- time ----------

// Device clock: there is no client-reachable time route.
function now() { return Date.now(); }

// ---------- platform REST (hosted only) ----------

// Platform calls go through the SDK (Bearer + renewal). Without a launch token nothing
// is requested. Failures are recoverable UI states ({ ok:false, error }), not exceptions.
async function api(path, opts) {
	opts = opts || {};
	if (!hosted()) return { ok: false, error: 'not-signed-in' };
	try {
		const data = await sdk().api(path, { method: opts.method || 'GET', body: opts.body, keepalive: opts.keepalive });
		return { ok: true, data: data == null ? null : data };
	} catch (e) {
		return { ok: false, status: e && e.status || 0, error: (e && e.message) || 'error', offline: !(e && e.status) };
	}
}

// ---------- settings & progression persistence ----------

const SETTINGS_KEY = 'pocket-greens.settings.v1';
const PROGRESS_KEY = 'pocket-greens.progress.v1';

const DEFAULT_SETTINGS = {
	audio: { music: 0.6, effects: 0.9, ambience: 0.5, voice: 0.8, muted: false, captions: false },
	graphics: { tier: 'auto', reducedMotion: false, highContrast: false, largeText: false, palette: 'default' },
	controls: { leftHanded: false, holdToAim: false, timingAssist: false, haptics: true, camera: 'follow' },
	tutorial: { completed: {} },
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
function saveSettings(s) { saveLocal(SETTINGS_KEY, s); syncSettings(s); }

// Per-player settings KV: changed top-level preference keys go up in one PATCH.
const sentSettings = {};
let settingsLoaded = false; // no PATCH before the platform values were read
function syncSettings(s) {
	if (!hosted() || !settingsLoaded) return Promise.resolve(null);
	const patch = {};
	for (const k of Object.keys(DEFAULT_SETTINGS)) {
		if (!(k in s)) continue;
		const json = JSON.stringify(s[k]);
		if (sentSettings[k] !== json) { patch[k] = s[k]; sentSettings[k] = json; }
	}
	return Object.keys(patch).length ? sdk().patchSettings(patch) : Promise.resolve(null);
}

// Platform values win over local ones on start (known keys only).
async function loadRemoteSettings(local) {
	if (!hosted()) return local;
	const remote = (await sdk().getSettings()) || {};
	settingsLoaded = true;
	const out = JSON.parse(JSON.stringify(local));
	for (const [k, v] of Object.entries(remote)) {
		sentSettings[k] = JSON.stringify(v);
		if (k in DEFAULT_SETTINGS && v && typeof v === 'object') out[k] = Object.assign({}, out[k], v);
	}
	saveLocal(SETTINGS_KEY, out);
	syncSettings(out);
	return out;
}

// Keyboard bindings ({ action: codes[] }) with the player's platform overrides.
function loadBindings(defaults) {
	const copy = () => JSON.parse(JSON.stringify(defaults));
	if (!hosted()) return Promise.resolve(copy());
	return sdk().loadBindings(defaults).catch(copy);
}

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

// localStorage write plus cloud mirror scheduling; the cloud slot is a mirror of the
// same checksummed document, never the source of truth offline.
function saveProgress(p) {
	p.checksum = checksum(p);
	saveLocal(PROGRESS_KEY, p);
	queueCloudSave(p);
}

// ---------- cloud save (slot game:<slug>) ----------

let lastSavedJson = '';  // cloud already holds this; skip redundant uploads

function setSync(s) {
	state.sync = s;
	if (platformApi.onSync) platformApi.onSync(s);
}

// Debounced mirror upload (~2 s); the pagehide/visibilitychange listeners flush below.
function queueCloudSave(progressDoc) {
	if (!hosted()) return;
	const json = JSON.stringify(progressDoc);
	if (json === lastSavedJson) return;
	lastSavedJson = json;
	setSync('saving');
	sdk().saveJSON(JSON.parse(json), 2000);
}

function flushCloudSave() {
	if (!hosted()) return Promise.resolve(false);
	return sdk().flushSave(true);
}

// Boot-time merge: a valid remote document wins over the local cache (the platform
// copy is authoritative for the account); localStorage stays the offline cache.
async function loadAdoptedProgress(localProgress) {
	if (!hosted()) return localProgress;
	const remote = await sdk().loadJSON();
	if (remote && remote.version === DEFAULT_PROGRESS.version && remote.checksum === checksum(remote)) {
		saveLocal(PROGRESS_KEY, remote);
		lastSavedJson = JSON.stringify(remote);
		setSync('synced');
		return remote;
	}
	return localProgress;
}

// ---------- profile / nickname ----------

// NICKNAME only — never the username. "Player "+id fallback when the profile is missing.
async function nicknameFor(userId) {
	const p = hosted() ? await sdk().profile(String(userId)) : null;
	return p ? p.displayName : 'Player ' + String(userId).slice(0, 6);
}

async function refreshIdentity() {
	if (!hosted()) { if (platformApi.onIdentity) platformApi.onIdentity(null); return; }
	state.nickname = await nicknameFor(state.sub);
	if (platformApi.onIdentity) platformApi.onIdentity({ id: state.sub, name: state.nickname });
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

if (hasWindow) {
	window.addEventListener('pagehide', () => { flushCloudSave(); });
	document.addEventListener('visibilitychange', () => { if (document.hidden) flushCloudSave(); });
	window.addEventListener('online', () => { state.online = true; });
	window.addEventListener('offline', () => { state.online = false; });
	initAuth();
}

const platformApi = {
	now, api, state, initAuth,
	loadSettings, saveSettings, loadProgress, saveProgress, syncSettings, loadRemoteSettings, loadBindings,
	loadAdoptedProgress, queueCloudSave, flushCloudSave,
	nicknameFor, refreshIdentity, canSignIn, signIn, inviteLink,
	ACHIEVEMENTS, unlockAchievement, recordHoleStreak, DEFAULT_SETTINGS, DEFAULT_PROGRESS,
	onIdentity: null, onSync: null, onAuth: null,
};

if (typeof module !== 'undefined' && module.exports) module.exports = platformApi;
else { window.PG = window.PG || {}; window.PG.platform = platformApi; }
})();
