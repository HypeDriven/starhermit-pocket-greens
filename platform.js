'use strict';
(function () {

// Pocket Greens — platform adapter. Hosted (StarHermit) mode activates iff a launch
// token was read from the URL fragment; every REST call then carries Bearer auth, the
// account nickname is fetched from the profile endpoint, and progress mirrors to the
// account cloud-save slot (localStorage stays the offline cache). Without a token the
// module talks to the game's own dev server (local play): time sync, presence,
// telemetry, sessions and the dev leaderboard. Access/launch tokens are never
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
	token: null,           // launch token (memory only, never persisted)
	sub: null,             // user id from the token's JWT payload
	slug: null,            // game scope from the token's JWT payload
	hosted: false,         // true once a usable launch token has been read
	sync: 'offline',       // cloud-save status: offline | saving | synced | error
	nickname: null,        // resolved account nickname (hosted only)
};

// ---------- launch token ----------

// JWT payload (base64url) is decoded, not verified — the platform is same-origin.
function decodeJwtPayload(jwt) {
	const parts = String(jwt || '').split('.');
	if (parts.length < 2) return null;
	try {
		const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
		const json = JSON.parse(atob(b64 + '='.repeat((4 - b64.length % 4) % 4)));
		return (json && typeof json === 'object') ? json : null;
	} catch (e) { return null; }
}

// The launch token arrives in the URL fragment (#game_token=<jwt>[&session_id=…]):
// read once, then strip it. Query-param fallbacks are local-dev conveniences and are
// never consulted on the platform host.
function readToken() {
	if (!hasWindow || !window.location) return null;
	const loc = window.location;
	let token = null;
	if (loc.hash) {
		const params = new URLSearchParams(loc.hash.slice(1));
		token = params.get('game_token') || null;
		if (token) {
			try { history.replaceState(null, '', loc.pathname + loc.search); }
			catch (e) { /* old WebView: keep playing, the token simply stays in the URL */ }
		}
	}
	if (!token && !/(^|\.)starhermit\.com$/i.test(loc.hostname)) {
		const q = new URLSearchParams(loc.search);
		token = q.get('game_token') || q.get('token') || q.get('launch') || q.get('launch_token') || null;
	}
	return token;
}

let refreshTimer = null;

function scheduleRefresh() {
	clearTimeout(refreshTimer);
	refreshTimer = setTimeout(refreshToken, 45 * 60 * 1000); // tokens live 60 min: re-mint at 45
}

// Scoped tokens may re-mint: POST the current token, swap in the returned one.
async function refreshToken() {
	if (!state.hosted || !state.slug) return;
	const res = await api('/api/v1/games/' + encodeURIComponent(state.slug) + '/launch-token', {
		method: 'POST', body: { token: state.token },
	});
	const next = res.ok && res.data && (res.data.token || res.data.launchToken || res.data.access_token || res.data.accessToken);
	if (next) { state.token = String(next); scheduleRefresh(); return; }
	setTimeout(refreshToken, 60 * 1000); // transient failure: retry in ~60 s
}

function initAuth() {
	const token = readToken();
	if (!token) return;
	const claims = decodeJwtPayload(token);
	if (!claims || !claims.sub || !claims.game_scope) return;
	state.token = token;
	state.sub = String(claims.sub);
	state.slug = String(claims.game_scope);
	state.hosted = true;
	scheduleRefresh();
}

// ---------- time ----------

// GET /api/v1/time with round-trip adjustment; falls back to the local clock offline.
// The platform exposes no time endpoint for launch tokens, so hosted play keeps the
// local clock (the daily setup screen labels which one is in use).
async function syncTime() {
	if (!hasWindow || !window.fetch) return now();
	if (state.hosted) { state.timeSynced = false; return now(); }
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

// ---------- REST helpers ----------

// Structured {"error":"..."} responses and rate limits are recoverable UI states:
// the caller receives { ok:false, error, retryAfter } rather than an exception.
async function send(path, opts) {
	opts = opts || {};
	const url = state.base + path;
	let attempt = 0;
	while (attempt < 3) {
		attempt += 1;
		try {
			const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
			if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
			const res = await fetch(url, {
				method: opts.method || 'GET',
				headers,
				body: opts.body ? JSON.stringify(opts.body) : undefined,
				keepalive: !!opts.keepalive, // pagehide flushes must survive tab teardown
			});
			if (res.status === 429) {
				const wait = Number(res.headers.get('Retry-After')) * 1000 || 1000 * attempt;
				await new Promise(r => setTimeout(r, wait));
				continue;
			}
			return { ok: res.ok, status: res.status, res };
		} catch (e) {
			if (attempt >= 3) return { ok: false, status: 0, error: 'offline', offline: true };
			await new Promise(r => setTimeout(r, 300 * attempt));
		}
	}
	return { ok: false, status: 0, error: 'unreachable' };
}

async function api(path, opts) {
	const r = await send(path, opts);
	if (r.res) {
		const body = await r.res.json().catch(() => ({}));
		if (!r.ok) return { ok: false, status: r.status, error: body.error || ('http-' + r.status) };
		return { ok: true, data: body };
	}
	return { ok: false, error: r.error, offline: r.offline };
}

// Binary variant for the cloud-save slot (GET returns application/zip bytes).
async function apiBytes(path, opts) {
	const r = await send(path, opts);
	if (r.res) {
		if (!r.ok) return { ok: false, status: r.status, error: 'http-' + r.status };
		return { ok: true, status: r.status, bytes: await r.res.arrayBuffer() };
	}
	return { ok: false, error: r.error, offline: r.offline };
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

// localStorage write plus cloud mirror scheduling; the cloud slot is a mirror of the
// same checksummed document, never the source of truth offline.
function saveProgress(p) {
	p.checksum = checksum(p);
	saveLocal(PROGRESS_KEY, p);
	queueCloudSave(p);
}

// ---------- cloud save (one slot, zip + base64) ----------

// Minimal ZIP writer/reader (stored entries only, no compression).
const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();
function crc32(bytes) {
	let c = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}
function zipStore(name, dataBytes) {
	const enc = new TextEncoder();
	const nameB = enc.encode(name);
	const crc = crc32(dataBytes);
	const out = [];
	const u16 = (v) => out.push(v & 0xff, (v >> 8) & 0xff);
	const u32 = (v) => out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
	u32(0x04034b50); u16(20); u16(0); u16(0); u16(0); u16(0);
	u32(crc); u32(dataBytes.length); u32(dataBytes.length);
	u16(nameB.length); u16(0);
	const local = out.length;
	const head = new Uint8Array(out);
	const cd = [];
	const c16 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff);
	const c32 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
	c32(0x02014b50); c16(20); c16(20); c16(0); c16(0); c16(0); c16(0);
	c32(crc); c32(dataBytes.length); c32(dataBytes.length);
	c16(nameB.length); c16(0); c16(0); c16(0); c16(0); c32(0); c32(0); // attrs + local-header offset
	const cdHead = new Uint8Array(cd);
	const cdOff = head.length + nameB.length + dataBytes.length;
	const parts = [head, nameB, dataBytes, cdHead, nameB];
	const eocd = [];
	const e32 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
	const e16 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff);
	e32(0x06054b50); e16(0); e16(0); e16(1); e16(1);
	e32(cdHead.length + nameB.length); e32(cdOff); e16(0);
	parts.push(new Uint8Array(eocd));
	const total = parts.reduce((n, p) => n + p.length, 0);
	const buf = new Uint8Array(total);
	let o = 0;
	for (const p of parts) { buf.set(p, o); o += p.length; }
	return buf;
}
function unzipFirstEntry(zipBytes) {
	// Stored single-entry reader: scan local headers for compression 0.
	const dv = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
	let off = 0;
	while (off + 30 <= zipBytes.length && dv.getUint32(off, true) === 0x04034b50) {
		const method = dv.getUint16(off + 8, true);
		const size = dv.getUint32(off + 18, true);
		const nameLen = dv.getUint16(off + 26, true);
		const extraLen = dv.getUint16(off + 28, true);
		const dataOff = off + 30 + nameLen + extraLen;
		if (method !== 0) throw new Error('unsupported zip entry');
		return zipBytes.slice(dataOff, dataOff + size);
	}
	throw new Error('bad zip');
}
function bytesToBase64(bytes) {
	let s = '';
	for (let i = 0; i < bytes.length; i += 0x8000)
		s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
	return btoa(s);
}
function base64ToBytes(b64) {
	const s = atob(b64);
	const b = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
	return b;
}

let cloudTimer = null;
let pendingDoc = null;   // newest unsaved progress doc
let lastSavedJson = '';  // cloud already holds this; skip redundant uploads

function setSync(s) {
	state.sync = s;
	if (platformApi.onSync) platformApi.onSync(s);
}

// Debounced mirror upload (~2 s); the pagehide/visibilitychange listeners flush below.
function queueCloudSave(progressDoc) {
	if (!state.hosted || !state.slug) return;
	pendingDoc = JSON.parse(JSON.stringify(progressDoc));
	setSync('saving');
	clearTimeout(cloudTimer);
	cloudTimer = setTimeout(flushCloudSave, 2000);
}

async function flushCloudSave() {
	if (!state.hosted || !state.slug || !pendingDoc) return;
	const doc = pendingDoc;
	pendingDoc = null;
	const json = JSON.stringify(doc);
	if (json === lastSavedJson) { setSync(state.online === false ? 'offline' : 'synced'); return; }
	clearTimeout(cloudTimer);
	cloudTimer = null;
	const bytes = zipStore('progress.json', new TextEncoder().encode(json));
	const res = await api('/api/v1/me/cloud-saves/' + encodeURIComponent(state.slug), {
		method: 'PUT', body: { dataBase64: bytesToBase64(bytes) }, keepalive: true,
	});
	if (res.ok) { lastSavedJson = json; setSync('synced'); return; }
	pendingDoc = doc; // put it back for the next flush
	setSync(res.offline || state.online === false ? 'offline' : 'error');
}

async function loadCloudProgress() {
	if (!state.hosted || !state.slug) return null;
	const res = await apiBytes('/api/v1/me/cloud-saves/' + encodeURIComponent(state.slug));
	if (!res.ok) return null; // 404 = no save yet, anything else = keep the local copy
	try {
		const raw = unzipFirstEntry(new Uint8Array(res.bytes));
		return JSON.parse(new TextDecoder().decode(raw));
	} catch (e) { return null; }
}

// Boot-time merge: a valid remote document wins over the local cache (the platform
// copy is authoritative for the account); localStorage stays the offline cache.
async function loadAdoptedProgress(localProgress) {
	if (!state.hosted) return localProgress;
	const remote = await loadCloudProgress();
	if (remote && remote.version === DEFAULT_PROGRESS.version && remote.checksum === checksum(remote)) {
		saveLocal(PROGRESS_KEY, remote);
		lastSavedJson = JSON.stringify(remote);
		setSync('synced');
		return remote;
	}
	return localProgress;
}

// ---------- profile / nickname ----------

const profileCache = new Map(); // userId -> profile object (hosted lookups only)

async function profileFor(userId) {
	if (!state.hosted || !userId) return null;
	if (profileCache.has(userId)) return profileCache.get(userId);
	const res = await api('/api/v1/users/' + encodeURIComponent(userId) + '/profile');
	const p = res.ok && res.data && typeof res.data === 'object' ? res.data : null;
	if (p) profileCache.set(userId, p);
	return p;
}

// NICKNAME only — never the username. "Player "+id8 when the profile is missing.
async function nicknameFor(userId) {
	const p = await profileFor(userId);
	if (p && typeof p.nickname === 'string' && p.nickname.trim()) return p.nickname.trim();
	return 'Player ' + String(userId).slice(0, 8);
}

async function refreshIdentity() {
	if (!state.hosted) { if (platformApi.onIdentity) platformApi.onIdentity(null); return; }
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

// ---------- presence & activity ----------

// The platform exposes no per-game presence endpoint reachable by launch tokens, so
// heartbeats are a dev-server feature only; hosted mode stays silent (no 404 churn).
function startActivity(kind) {
	stopActivity();
	if (!hasWindow || state.hosted) return;
	// throttled heartbeat while actively playing; accurate playtime pairing
	state.heartbeatTimer = setInterval(() => {
		api('/api/v1/presence', { method: 'POST', body: { activity: kind, at: now() } });
	}, 45000);
	api('/api/v1/presence', { method: 'POST', body: { activity: kind, start: true, at: now() } });
}

function stopActivity() {
	if (state.heartbeatTimer) { clearInterval(state.heartbeatTimer); state.heartbeatTimer = null; }
	if (hasWindow && !state.hosted) api('/api/v1/presence', { method: 'POST', body: { activity: null, end: true, at: now() } });
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
	if (state.hosted || !state.events.length) return; // dev-server funnel only
	const batch = state.events.splice(0, state.events.length);
	await api('/api/v1/telemetry', { method: 'POST', body: { events: batch } });
}

function setConsent(c) { state.consent = !!c; }

if (hasWindow) {
	window.addEventListener('pagehide', () => { flushCloudSave(); });
	document.addEventListener('visibilitychange', () => { if (document.hidden) flushCloudSave(); });
	window.addEventListener('online', () => { state.online = true; });
	window.addEventListener('offline', () => { state.online = false; });
	initAuth();
}

const platformApi = {
	syncTime, now, api, apiBytes, state,
	loadSettings, saveSettings, loadProgress, saveProgress,
	loadAdoptedProgress, queueCloudSave, flushCloudSave,
	profileFor, nicknameFor, refreshIdentity,
	zipStore, unzipFirstEntry, bytesToBase64, base64ToBytes, decodeJwtPayload,
	ACHIEVEMENTS, unlockAchievement, recordHoleStreak, FUNNEL_EVENTS, track, flushTelemetry, setConsent,
	startActivity, stopActivity, DEFAULT_SETTINGS, DEFAULT_PROGRESS,
	onIdentity: null, onSync: null,
};

if (typeof module !== 'undefined' && module.exports) module.exports = platformApi;
else { window.PG = window.PG || {}; window.PG.platform = platformApi; }
})();
