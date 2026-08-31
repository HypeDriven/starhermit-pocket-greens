'use strict';
(function () {

// Pocket Greens — session: local/hosted commands, snapshots, prediction policy, reconnect, replay.
// A session is a round of one or more holes. Rules state is only mutated through validated
// commands; rendering/UI consume immutable snapshots.

const RULES = (typeof module !== 'undefined' && module.exports) ? require('./rules') : window.PG.rules;

const REPLAY_SCHEMA = 1;

let cmdCounter = 0;
function nextCmdId(sessionId) {
	cmdCounter += 1;
	return sessionId + '-' + cmdCounter.toString(36) + '-' + Date.now().toString(36);
}

// opts: { id, seed, holes: [course], players: [ids], mode, challenge? }
function newSession(opts) {
	const holes = opts.holes;
	if (!holes || !holes.length) throw new Error('session requires at least one hole');
	const sess = {
		id: opts.id || ('local-' + Date.now().toString(36)),
		mode: opts.mode || 'practice',
		seed: String(opts.seed || '0'),
		holes,
		holeIndex: 0,
		state: RULES.makeState(opts.seed + ':' + holes[0].id, holes[0], opts.players),
		totals: {},             // playerId -> { strokes, penalties, holes }
		undone: [],             // undo stack (practice only)
		commands: [],           // ordered commands for the replay envelope
		hashes: [],             // periodic state hashes
		startedAt: Date.now(),
		elapsedMs: 0,
		finished: false,
		result: null,
		challenge: opts.challenge || null,
		challengeStatus: null,  // live challenge constraint status
	};
	for (const p of sess.state.players) sess.totals[p.id] = { strokes: 0, penalties: 0, holes: 0 };
	return sess;
}

function snapshot(sess) { return JSON.parse(JSON.stringify(sess.state)); }

function recordHash(sess) {
	if (sess.commands.length % 5 === 0) {
		sess.hashes.push({ n: sess.commands.length, hash: RULES.hashState(sess.state) });
	}
}

// Apply a validated command; returns { events, error }. Undo snapshots are taken before
// mutating so practice undo restores the exact prior state.
function applyCommand(sess, cmd) {
	if (sess.finished) return { events: [], error: 'session-finished' };
	const course = sess.holes[sess.holeIndex];
	const full = Object.assign({}, cmd, { id: cmd.id || nextCmdId(sess.id), by: cmd.by || sess.state.players[sess.state.currentPlayer].id });
	const err = RULES.invalidReason(sess.state, full);
	if (err) {
		// count invalid attempts for tie-breaks without advancing the simulation
		const p = sess.state.players.find(pl => pl.id === full.by);
		if (p) p.invalid += 1;
		return { events: [{ type: 'invalid', reason: err }], error: err };
	}
	sess.undone.push(JSON.stringify(sess.state));
	if (sess.undone.length > 64) sess.undone.shift();
	const res = RULES.step(sess.state, course, full);
	sess.state = res.state;
	sess.commands.push(full);
	recordHash(sess);
	applyChallengeStatus(sess, res.events);
	if (sess.state.terminal) advanceHole(sess, res.events);
	return { events: res.events, error: null, trace: res.trace };
}

// Challenge constraints are validated from the event stream, never from client claims.
function applyChallengeStatus(sess, events) {
	const ch = sess.challenge;
	if (!ch) return;
	for (const e of events) {
		if (ch.noPenalties && e.type === 'splash') sess.challengeStatus = 'failed:penalty';
		if (ch.strokeLimit && sess.state.players[0] && sess.state.players[0].strokes > ch.strokeLimit) sess.challengeStatus = 'failed:stroke-limit';
		if (ch.timeLimitTicks && sess.state.tick > ch.timeLimitTicks) sess.challengeStatus = 'failed:time-limit';
		if (ch.requireBounce && e.type === 'strike') sess._awaitBounce = true;
		if (ch.requireBounce && e.type === 'bounce') sess._awaitBounce = false;
	}
	if (ch.requireBounce && sess._awaitBounce && events.some(e => e.type === 'holed' || e.type === 'capped' || sess.state.phase === 'aim')) {
		if (events.some(e => e.type === 'strike')) { /* still rolling */ }
		else if (!events.some(e => e.type === 'bounce') && events.length) sess.challengeStatus = 'failed:no-bounce';
	}
	if (ch.maxPower && sess.commands.length) {
		const last = sess.commands[sess.commands.length - 1];
		if (last.type === 'strike' && last.power > ch.maxPower) sess.challengeStatus = 'failed:power-limit';
	}
}

function advanceHole(sess, events) {
	for (const r of sess.state.holeResults) {
		const t = sess.totals[r.id];
		if (t.holes <= sess.holeIndex) {
			t.strokes += r.strokes; t.penalties += r.penalties; t.holes = sess.holeIndex + 1;
		}
	}
	events.push({ type: 'hole-summary', hole: sess.holeIndex, totals: JSON.parse(JSON.stringify(sess.totals)) });
	if (sess.holeIndex + 1 >= sess.holes.length) {
		sess.finished = true;
		sess.elapsedMs = Date.now() - sess.startedAt;
		const results = sess.state.players.map(p => {
			const t = sess.totals[p.id];
			return {
				id: p.id, total: t.strokes + t.penalties, strokes: t.strokes, penalties: t.penalties,
				holes: t.holes, invalid: p.invalid, elapsedMs: sess.elapsedMs,
			};
		});
		// Tie order: total, holes completed, fewer invalids, lower elapsed, stable id.
		results.sort((a, b) => (a.total - b.total) || (b.holes - a.holes) || (a.invalid - b.invalid) ||
			(a.elapsedMs - b.elapsedMs) || (a.id < b.id ? -1 : 1));
		sess.result = {
			reason: 'completed', results,
			challenge: sess.challenge ? { id: sess.challenge.id, status: sess.challengeStatus || 'passed' } : null,
			perHole: sess.holes.map((h, i) => ({ id: h.id, par: h.par })),
		};
		events.push({ type: 'session-complete', result: sess.result });
		return;
	}
	sess.holeIndex += 1;
	const next = sess.holes[sess.holeIndex];
	const players = sess.state.players.map(p => p.id);
	const carriedInvalid = {};
	for (const p of sess.state.players) carriedInvalid[p.id] = p.invalid;
	sess.state = RULES.makeState(sess.seed + ':' + next.id + ':' + sess.holeIndex, next, players);
	for (const p of sess.state.players) p.invalid = carriedInvalid[p.id] || 0;
	events.push({ type: 'next-hole', hole: sess.holeIndex, courseId: next.id });
}

// Practice undo: restores the exact state before the last command. Not available in
// ranked/competitive modes (session mode decides; the engine only exposes the mechanism).
function undo(sess) {
	if (!sess.undone.length) return false;
	sess.state = JSON.parse(sess.undone.pop());
	sess.commands.pop();
	return true;
}

// ---------- replay ----------

function replayEnvelope(sess) {
	return {
		schema: REPLAY_SCHEMA,
		rulesVersion: RULES.RULES_VERSION,
		seed: sess.seed,
		holes: sess.holes.map(h => h.id + '@' + (h.contentVersion || 1)),
		initialHash: sess.hashes.length ? sess.hashes[0].hash : null,
		timestampOffset: 0,
		commands: sess.commands.slice(),
		hashes: sess.hashes.slice(),
		result: sess.result,
	};
}

// Deterministic replay check: re-run commands and compare hashes and terminal result.
function verifyReplay(sess, envelope) {
	const env = envelope || replayEnvelope(sess);
	const check = newSession({ id: sess.id, seed: env.seed, holes: sess.holes, players: sess.state.players.map(p => p.id), mode: sess.mode, challenge: sess.challenge });
	for (const cmd of env.commands) applyCommand(check, cmd);
	// elapsedMs is wall-clock metadata, not rules state; strip it before comparing results
	const strip = (r) => JSON.parse(JSON.stringify(r, (k, v) => (k === 'elapsedMs' ? undefined : v)));
	return {
		ok: JSON.stringify(strip(check.result)) === JSON.stringify(strip(env.result)) &&
			check.hashes.every((h, i) => !env.hashes[i] || h.hash === env.hashes[i].hash),
		hashes: check.hashes,
	};
}

// ---------- deterministic practice AI ----------

// Seeded solver that plays like a cautious mid-handicap player. Deterministic per seed so
// practice sessions and replays are reproducible.
function aiStrike(sess, aiId) {
	const st = sess.state;
	const course = sess.holes[sess.holeIndex];
	const p = st.players.find(pl => pl.id === aiId);
	if (!p) return null;
	const r = RULES.mulberry32(RULES.hashStr('ai:' + sess.seed + ':' + sess.holeIndex + ':' + p.strokes));
	const aim = Math.atan2(course.cup.y - p.ball.y, course.cup.x - p.ball.x);
	const dist = Math.hypot(course.cup.x - p.ball.x, course.cup.y - p.ball.y);
	const angle = aim + (r() - 0.5) * 0.22;
	const power = Math.min(95, Math.max(18, dist * 11 + (r() - 0.5) * 18));
	return { type: 'strike', angle, power, by: aiId };
}

const api = {
	REPLAY_SCHEMA, newSession, applyCommand, snapshot, undo,
	replayEnvelope, verifyReplay, aiStrike,
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
else { window.PG = window.PG || {}; window.PG.session = api; }
})();
