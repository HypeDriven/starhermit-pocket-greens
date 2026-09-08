'use strict';

// Pocket Greens — authoritative server: static files, platform APIs, and hosted sessions.
// Rules run server-side via the same rules.js the client uses; client clocks, scores, and
// completion claims are never trusted. Sessions persist compact JSON state; commands are
// validated for membership, turn, bounds, and legality, and rejected idempotently by ID.

const http = require('http');
const fs = require('fs');
const path = require('path');
const RULES = require('./rules');
const CONTENT = require('./content');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 8080;
const DATA_FILE = path.join(ROOT, '.server-data.json');

const MIME = {
	'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
	'.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
	'.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm',
	'.opus': 'audio/ogg',
};

// ---------- persisted state (leaderboard survives restarts) ----------

const db = { leaderboard: [], sessions: {}, telemetry: [] };
try {
	const raw = fs.readFileSync(DATA_FILE, 'utf8');
	const parsed = JSON.parse(raw);
	if (parsed && typeof parsed === 'object') Object.assign(db, parsed);
} catch (e) { /* first boot or unreadable: start clean */ }

let saveTimer = null;
function persist() {
	clearTimeout(saveTimer);
	saveTimer = setTimeout(() => {
		try { fs.writeFileSync(DATA_FILE, JSON.stringify({ leaderboard: db.leaderboard })); } catch (e) { /* read-only fs */ }
	}, 250);
}

// Static-file containment. The comparison must include the separator: a bare prefix
// test also accepts sibling directories such as "<ROOT>-backup" reached through "../".
function isInsideRoot(p) {
	return p === ROOT || p.startsWith(ROOT + path.sep);
}

function send(res, code, body, headers) {
	const isObj = body !== null && typeof body === 'object';
	res.writeHead(code, Object.assign({ 'Content-Type': isObj ? 'application/json' : 'text/plain; charset=utf-8' }, headers || {}));
	res.end(isObj ? JSON.stringify(body) : body);
}

function readBody(req) {
	return new Promise((resolve) => {
		let data = '';
		let tooBig = false;
		req.on('data', (c) => {
			data += c;
			if (data.length > 64 * 1024) { tooBig = true; req.destroy(); } // payload-size bound
		});
		req.on('end', () => {
			if (tooBig) return resolve(null);
			try { resolve(data ? JSON.parse(data) : {}); } catch (e) { resolve(null); }
		});
		req.on('error', () => resolve(null));
	});
}

// ---------- hosted sessions ----------

function resolveCourse(body) {
	// The server trusts its own content registry, not client-supplied geometry.
	if (body.daily || !body.courseIds || !body.courseIds.length) return CONTENT.dailyCourse();
	const known = CONTENT.getLevel(body.courseIds[0]);
	return known || CONTENT.dailyCourse();
}

// Sessions live in memory only; drop the ones past their deadline so a long-running
// server does not accumulate abandoned matches.
function pruneSessions() {
	const now = Date.now();
	for (const id of Object.keys(db.sessions)) {
		if (db.sessions[id].deadline < now) delete db.sessions[id];
	}
}

function createSession(body) {
	pruneSessions();
	const course = resolveCourse(body);
	const count = body.players === 2 ? 2 : 1;
	const ids = count === 2 ? ['host', 'guest'] : ['host'];
	const id = 'h' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
	const state = RULES.makeState(id, course, ids);
	db.sessions[id] = {
		id, course, state, created: Date.now(), commandIds: {},
		moves: 0, lastMoveAt: Date.now(), deadline: Date.now() + 30 * 60 * 1000,
	};
	return db.sessions[id];
}

function sessionView(s, sinceMoves) {
	return {
		id: s.id,
		players: s.state.players.map(p => p.id),
		state: s.state,
		course: s.course,
		movesSince: sinceMoves || 0,
		deadline: s.deadline,
	};
}

function applyServerCommand(s, cmd) {
	if (!cmd || typeof cmd !== 'object') return { status: 400, body: { error: 'malformed-command' } };
	if (cmd.id && s.commandIds[cmd.id]) {
		// duplicate command: idempotent replay of the current state
		return { status: 200, body: { state: s.state, events: [], trace: [], duplicate: true } };
	}
	if (Date.now() > s.deadline) return { status: 410, body: { error: 'session-expired' } };
	const err = RULES.invalidReason(s.state, cmd);
	if (err) return { status: 422, body: { error: err } };
	const res = RULES.step(s.state, s.course, cmd);
	if (res.error) return { status: 422, body: { error: res.error } };
	s.state = res.state;
	if (cmd.id) s.commandIds[cmd.id] = true;
	s.moves += 1;
	s.lastMoveAt = Date.now();
	return { status: 200, body: { state: s.state, events: res.events, trace: res.trace } };
}

// ---------- leaderboard ----------

// Every submission carries ruleset, content version, seed, assists, duration.
// Impossible or stale-version scores are rejected.
function submitScore(body) {
	if (!body || typeof body !== 'object') return { status: 400, body: { error: 'malformed' } };
	const score = Number(body.score);
	if (!Number.isInteger(score) || score < 1 || score > 200) return { status: 422, body: { error: 'impossible-score' } };
	if (body.rulesVersion !== RULES.RULES_VERSION) return { status: 422, body: { error: 'stale-version' } };
	if (body.contentVersion !== CONTENT.CONTENT_VERSION) return { status: 422, body: { error: 'stale-version' } };
	if (typeof body.seed !== 'string' || body.seed.length > 64) return { status: 422, body: { error: 'bad-seed' } };
	const entry = {
		score, seed: body.seed, board: body.board === 'daily' ? 'daily' : 'global',
		assists: Array.isArray(body.assists) ? body.assists.slice(0, 4).map(String) : [],
		durationMs: Math.max(0, Math.min(3.6e6, Number(body.durationMs) || 0)),
		at: Date.now(),
	};
	db.leaderboard.push(entry);
	const board = db.leaderboard.filter(e => e.board === entry.board && e.seed === entry.seed)
		.sort((a, b) => a.score - b.score || a.durationMs - b.durationMs);
	db.leaderboard = db.leaderboard.slice(-500);
	persist();
	return { status: 200, body: { rank: board.indexOf(entry) + 1, entries: board.slice(0, 10) } };
}

// ---------- router ----------

const server = http.createServer(async (req, res) => {
	const u = (req.url || '/').split('?')[0];

	// platform APIs
	if (u === '/api/v1/time') return send(res, 200, { now: Date.now() });
	if (u === '/api/v1/daily') return send(res, 200, { seed: CONTENT.dailySeed(), course: CONTENT.dailyCourse() });

	if (u === '/api/v1/presence' && req.method === 'POST') {
		const body = await readBody(req);
		if (body === null) return send(res, 400, { error: 'malformed' });
		return send(res, 200, { ok: true });
	}

	if (u === '/api/v1/telemetry' && req.method === 'POST') {
		const body = await readBody(req);
		if (body === null || !Array.isArray(body.events)) return send(res, 400, { error: 'malformed' });
		db.telemetry.push(...body.events.slice(0, 32));
		db.telemetry = db.telemetry.slice(-1000);
		return send(res, 200, { ok: true });
	}

	if (u === '/api/v1/leaderboard') {
		if (req.method === 'POST') {
			const body = await readBody(req);
			const r = submitScore(body);
			return send(res, r.status, r.body);
		}
		const board = (req.url.includes('board=daily')) ? 'daily' : 'global';
		const entries = db.leaderboard.filter(e => e.board === board)
			.sort((a, b) => a.score - b.score || a.durationMs - b.durationMs).slice(0, 20);
		return send(res, 200, { entries });
	}

	if (u === '/api/v1/sessions' && req.method === 'POST') {
		const body = await readBody(req);
		if (body === null) return send(res, 400, { error: 'malformed' });
		const s = createSession(body || {});
		return send(res, 200, { id: s.id, you: s.state.players[0].id, course: s.course, players: s.state.players.map(p => p.id) });
	}

	const mSess = u.match(/^\/api\/v1\/sessions\/([a-z0-9]+)$/i);
	if (mSess && req.method === 'GET') {
		const s = db.sessions[mSess[1]];
		if (!s) return send(res, 404, { error: 'no-such-session' });
		return send(res, 200, sessionView(s));
	}

	const mCmd = u.match(/^\/api\/v1\/sessions\/([a-z0-9]+)\/commands$/i);
	if (mCmd && req.method === 'POST') {
		const s = db.sessions[mCmd[1]];
		if (!s) return send(res, 404, { error: 'no-such-session' });
		const body = await readBody(req);
		const r = applyServerCommand(s, body);
		return send(res, r.status, r.body);
	}

	// static files (same-origin distribution; no secrets or source maps are shipped)
	if (req.method !== 'GET') return send(res, 405, { error: 'method-not-allowed' });
	const rel = u === '/' ? 'index.html' : u.replace(/^\/+/, '');
	const p = path.normalize(path.join(ROOT, rel));
	if (!isInsideRoot(p) || path.relative(ROOT, p).split(path.sep).some(part => part.startsWith('.'))) return send(res, 403, { error: 'forbidden' });
	let st;
	try { st = fs.statSync(p); if (!st.isFile()) throw new Error('nf'); } catch (e) { return send(res, 404, { error: 'not-found' }); }
	const type = MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
	res.writeHead(200, { 'Content-Type': type, 'Cache-Control': rel.startsWith('node_modules/') ? 'public, max-age=86400, immutable' : 'no-cache' });
	fs.createReadStream(p).pipe(res);
});

module.exports = server;
module.exports.isInsideRoot = isInsideRoot;
module.exports.ROOT = ROOT;

if (require.main === module) {
	server.listen(PORT, () => { console.log('Pocket Greens server on http://localhost:' + PORT); });
}
