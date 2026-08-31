'use strict';
(function () {

// Pocket Greens — rules: pure deterministic state transitions, legality, scoring, seeded random stream.
// No I/O, no DOM, no rendering. Consumed by session/render/ui/platform/bootstrap and the
// authoritative server. All state is JSON-serializable; `tick` is monotonically increasing.

const RULES_VERSION = 2;
const DT = 1 / 120;             // fixed simulation step (seconds)
const MAX_ROLL_TICKS = 120 * 25; // a single stroke resolves within 25 simulated seconds
const STOP_SPEED = 0.05;         // below this the ball is at rest
const CAPTURE_SPEED = 2.5;       // max speed at which the cup can capture the ball
const BALL_R = 0.16;
const CUP_R = 0.34;
const RESTITUTION = 0.72;
const FRICTION = 0.55;           // green damping coefficient (per second)
const SAND_FRICTION = 3.4;       // sand damping coefficient
const MAX_POWER = 9.0;           // launch speed at power = 100
const INVALID_TIME_PENALTY_MS = 0; // invalid actions are tracked as a tie-break count, not time

// ---------- deterministic utilities ----------

function mulberry32(seed) {
	let a = seed >>> 0;
	return function () {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function hashStr(s) {
	let h = 5381 >>> 0;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

function q(x) { return Math.round(x * 1e6) / 1e6; }

function stableStringify(v) {
	if (v === null || typeof v !== 'object') return JSON.stringify(v);
	if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
	return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

function hashState(st) { return hashStr(stableStringify(st)); }

// ---------- geometry helpers ----------

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

function pointInRect(px, py, r) {
	return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}

function inZone(px, py, zone) {
	if (zone.type === 'circle') {
		const dx = px - zone.x, dy = py - zone.y;
		return dx * dx + dy * dy <= zone.r * zone.r;
	}
	return pointInRect(px, py, zone);
}

// Mover displacement is a pure function of the absolute tick: deterministic and replayable.
function moverPos(m, tick) {
	const t = (tick * DT) / m.period + (m.phase || 0);
	const off = Math.sin(t * Math.PI * 2) * m.amp;
	if (m.axis === 'y') return { x: m.x, y: m.y + off, r: m.r };
	return { x: m.x + off, y: m.y, r: m.r };
}

// Resolve a moving circle (ball) against a static circle; returns corrected position/velocity.
function collideCircle(ball, cx, cy, cr) {
	const dx = ball.x - cx, dy = ball.y - cy;
	const rr = cr + BALL_R;
	const d2 = dx * dx + dy * dy;
	if (d2 >= rr * rr || d2 === 0) return false;
	const d = Math.sqrt(d2);
	const nx = dx / d, ny = dy / d;
	ball.x = q(cx + nx * rr);
	ball.y = q(cy + ny * rr);
	const vn = ball.vx * nx + ball.vy * ny;
	if (vn < 0) {
		ball.vx = q(ball.vx - (1 + RESTITUTION) * vn * nx);
		ball.vy = q(ball.vy - (1 + RESTITUTION) * vn * ny);
	}
	return true;
}

function collideRect(ball, rc) {
	const nx = clamp(ball.x, rc.x, rc.x + rc.w);
	const ny = clamp(ball.y, rc.y, rc.y + rc.h);
	const dx = ball.x - nx, dy = ball.y - ny;
	const d2 = dx * dx + dy * dy;
	if (d2 >= BALL_R * BALL_R) return false;
	if (d2 > 0) {
		const d = Math.sqrt(d2);
		const ux = dx / d, uy = dy / d;
		ball.x = q(nx + ux * BALL_R);
		ball.y = q(ny + uy * BALL_R);
		const vn = ball.vx * ux + ball.vy * uy;
		if (vn < 0) {
			ball.vx = q(ball.vx - (1 + RESTITUTION) * vn * ux);
			ball.vy = q(ball.vy - (1 + RESTITUTION) * vn * uy);
		}
	} else {
		// center inside the rect: push out along the shortest face
		const left = ball.x - rc.x, right = rc.x + rc.w - ball.x;
		const top = ball.y - rc.y, bottom = rc.y + rc.h - ball.y;
		const m = Math.min(left, right, top, bottom);
		if (m === left) { ball.x = q(rc.x - BALL_R); ball.vx = q(-Math.abs(ball.vx) * RESTITUTION); }
		else if (m === right) { ball.x = q(rc.x + rc.w + BALL_R); ball.vx = q(Math.abs(ball.vx) * RESTITUTION); }
		else if (m === top) { ball.y = q(rc.y - BALL_R); ball.vy = q(-Math.abs(ball.vy) * RESTITUTION); }
		else { ball.y = q(rc.y + rc.h + BALL_R); ball.vy = q(Math.abs(ball.vy) * RESTITUTION); }
	}
	return true;
}

// ---------- state construction ----------

function makePlayer(id, start) {
	return {
		id: String(id),
		ball: { x: q(start.x), y: q(start.y), vx: 0, vy: 0 },
		lastRest: { x: q(start.x), y: q(start.y) },
		strokes: 0,
		penalties: 0,
		invalid: 0,
		holed: false,
	};
}

// course: { id, par, cap, w, h, start:{x,y}, cup:{x,y}, walls:[rect], obstacles:[rect|circle],
//           water:[zone], sand:[zone], movers:[mover] }
function makeState(seed, course, playerIds) {
	const ids = (playerIds && playerIds.length ? playerIds : ['p1']).map(String);
	return {
		version: RULES_VERSION,
		seed: String(seed),
		contentVersion: course.contentVersion || 1,
		courseId: course.id,
		par: course.par,
		cap: course.cap || (course.par * 2 + 1),
		tick: 1,
		phase: 'aim', // aim -> roll -> (holed|capped) -> ... -> complete
		players: ids.map(id => makePlayer(id, course.start)),
		currentPlayer: 0,
		holeResults: [],   // per-player entries appended as each player finishes
		splash: null,      // one-tick event marker for render/audio: {x,y,player}
		bounce: null,      // one-tick event marker: {x,y,speed,material}
		terminal: null,    // {reason, results} when the round is complete
	};
}

// ---------- legality ----------

// Returns the reason a command is illegal, or null when legal. This is the single
// legality source used by UI, tutorials, hints, and the authoritative server.
function invalidReason(state, cmd) {
	if (!cmd || typeof cmd !== 'object') return 'malformed-command';
	if (typeof cmd.type !== 'string') return 'malformed-command';
	if (state.terminal) return 'round-complete';
	switch (cmd.type) {
		case 'strike': {
			if (state.phase !== 'aim') return 'not-awaiting-aim';
			const me = state.players[state.currentPlayer];
			if (cmd.by !== undefined && String(cmd.by) !== me.id) return 'out-of-turn';
			if (!Number.isFinite(cmd.angle) || !Number.isFinite(cmd.power)) return 'bad-stroke-params';
			if (cmd.power <= 0 || cmd.power > 100) return 'power-out-of-range';
			return null;
		}
		case 'next-hole':
			// hole transitions are driven internally by resolution; external next-hole is never legal
			return 'transition-is-automatic';
		default:
			return 'unknown-command';
	}
}

// Legal-action query used by play, hints, and tutorials alike.
function legalActions(state) {
	if (state.terminal) return [];
	if (state.phase === 'aim') {
		const me = state.players[state.currentPlayer];
		return [{ type: 'strike', by: me.id, angleRange: [0, Math.PI * 2], powerRange: [1, 100] }];
	}
	return []; // roll phase: input locked until resolution
}

// ---------- per-player hole accounting ----------

function holeScore(state, p) {
	// strokes taken; holed players keep their count, capped players take the cap
	return p.holed ? p.strokes + p.penalties : state.cap;
}

function finishRound(state) {
	const results = state.players.map(p => ({
		id: p.id,
		total: holeScore(state, p),
		strokes: p.strokes,
		penalties: p.penalties,
		invalid: p.invalid,
		holed: p.holed,
	}));
	// Tie order: primary objective (more holes completed = only one hole here, so holed first),
	// then fewer invalid actions, then lower elapsed time (server-supplied), then stable id.
	results.sort((a, b) =>
		(a.total - b.total) ||
		((b.holed ? 1 : 0) - (a.holed ? 1 : 0)) ||
		(a.invalid - b.invalid) ||
		((a.elapsedMs || 0) - (b.elapsedMs || 0)) ||
		(a.id < b.id ? -1 : 1));
	state.terminal = { reason: 'completed', results };
	state.phase = 'complete';
}

// ---------- simulation ----------

function currentPlayer(state) { return state.players[state.currentPlayer]; }

function stepTick(state, course, events) {
	state.tick += 1;
	const p = currentPlayer(state);
	if (!p || p.holed || state.phase !== 'roll') return;
	const b = p.ball;

	// damping by surface
	let friction = FRICTION;
	for (const s of (course.sand || [])) if (inZone(b.x, b.y, s)) { friction = SAND_FRICTION; break; }
	const damp = Math.max(0, 1 - friction * DT);
	b.vx = q(b.vx * damp);
	b.vy = q(b.vy * damp);

	b.x = q(b.x + b.vx * DT);
	b.y = q(b.y + b.vy * DT);

	// outer walls (course bounds)
	if (b.x < BALL_R) { b.x = BALL_R; b.vx = q(Math.abs(b.vx) * RESTITUTION); events.push({ type: 'bounce', x: b.x, y: b.y, material: 'wall' }); }
	if (b.x > course.w - BALL_R) { b.x = course.w - BALL_R; b.vx = q(-Math.abs(b.vx) * RESTITUTION); events.push({ type: 'bounce', x: b.x, y: b.y, material: 'wall' }); }
	if (b.y < BALL_R) { b.y = BALL_R; b.vy = q(Math.abs(b.vy) * RESTITUTION); events.push({ type: 'bounce', x: b.x, y: b.y, material: 'wall' }); }
	if (b.y > course.h - BALL_R) { b.y = course.h - BALL_R; b.vy = q(-Math.abs(b.vy) * RESTITUTION); events.push({ type: 'bounce', x: b.x, y: b.y, material: 'wall' }); }

	for (const w of (course.walls || [])) if (collideRect(b, w)) events.push({ type: 'bounce', x: b.x, y: b.y, material: 'wall' });
	for (const o of (course.obstacles || [])) {
		const hit = o.type === 'circle' ? collideCircle(b, o.x, o.y, o.r) : collideRect(b, o);
		if (hit) events.push({ type: 'bounce', x: b.x, y: b.y, material: o.material || 'wood' });
	}
	for (const m of (course.movers || [])) {
		const mp = moverPos(m, state.tick);
		if (collideCircle(b, mp.x, mp.y, mp.r)) events.push({ type: 'bounce', x: b.x, y: b.y, material: 'mover' });
	}

	// water: penalty stroke and reset to the last rest position
	for (const wz of (course.water || [])) {
		if (inZone(b.x, b.y, wz)) {
			p.penalties += 1;
			events.push({ type: 'splash', x: b.x, y: b.y, player: p.id });
			b.x = p.lastRest.x; b.y = p.lastRest.y; b.vx = 0; b.vy = 0;
			endRoll(state, p, events);
			return;
		}
	}

	// cup capture
	const cdx = b.x - course.cup.x, cdy = b.y - course.cup.y;
	const speed = Math.hypot(b.vx, b.vy);
	if (cdx * cdx + cdy * cdy <= CUP_R * CUP_R && speed <= CAPTURE_SPEED) {
		p.holed = true;
		b.x = q(course.cup.x); b.y = q(course.cup.y); b.vx = 0; b.vy = 0;
		events.push({ type: 'holed', player: p.id, strokes: p.strokes + p.penalties, par: state.par });
		endRoll(state, p, events);
		return;
	}

	if (speed < STOP_SPEED) { b.vx = 0; b.vy = 0; endRoll(state, p, events); }
}

function endRoll(state, p, events) {
	p.lastRest = { x: p.ball.x, y: p.ball.y };
	if (p.holed) {
		state.holeResults.push({ id: p.id, strokes: p.strokes, penalties: p.penalties, total: p.strokes + p.penalties });
		advanceTurn(state, events);
		return;
	}
	if (p.strokes + p.penalties >= state.cap) {
		events.push({ type: 'capped', player: p.id, cap: state.cap });
		state.holeResults.push({ id: p.id, strokes: p.strokes, penalties: p.penalties, total: state.cap });
		advanceTurn(state, events);
		return;
	}
	state.phase = 'aim';
	advanceTurn(state, events);
}

function advanceTurn(state, events) {
	// next player who has not yet holed out / been capped
	const done = new Set(state.holeResults.map(r => r.id));
	for (let i = 1; i <= state.players.length; i++) {
		const idx = (state.currentPlayer + i) % state.players.length;
		if (!done.has(state.players[idx].id)) {
			state.currentPlayer = idx;
			if (state.phase !== 'complete') state.phase = 'aim';
			return;
		}
	}
	finishRound(state);
	events.push({ type: 'round-complete', results: state.terminal.results });
}

// Apply one validated command. Returns { state, events, error }. Never mutates the input state.
function step(state, course, cmd) {
	const err = invalidReason(state, cmd);
	const next = JSON.parse(JSON.stringify(state));
	const events = [];
	const trace = [];
	if (err) {
		// track invalid attempts for the tie-break, but change nothing else
		if (cmd && cmd.by) {
			const p = next.players.find(pl => pl.id === String(cmd.by));
			if (p) p.invalid += 1;
		}
		return { state: next, events, error: err, trace };
	}
	if (cmd.type === 'strike') {
		const p = currentPlayer(next);
		p.strokes += 1;
		// quantized authoritative input: milliradian angle, 0.5% power steps
		const angle = Math.round(cmd.angle * 1000) / 1000;
		const power = Math.round(cmd.power * 2) / 2;
		const speed = (power / 100) * MAX_POWER;
		p.ball.vx = q(Math.cos(angle) * speed);
		p.ball.vy = q(Math.sin(angle) * speed);
		p.lastRest = { x: p.ball.x, y: p.ball.y };
		next.phase = 'roll';
		events.push({ type: 'strike', player: p.id, angle, power });
		const startTick = next.tick;
		// trace records the active ball position each tick for deterministic visual playback
		trace.push({ t: next.tick, x: p.ball.x, y: p.ball.y });
		while (next.phase === 'roll' && next.tick - startTick < MAX_ROLL_TICKS) {
			stepTick(next, course, events);
			trace.push({ t: next.tick, x: p.ball.x, y: p.ball.y });
		}
		if (next.phase === 'roll') {
			// bounded-duration guard: force the ball to rest exactly
			p.ball.vx = 0; p.ball.vy = 0;
			endRoll(next, p, events);
			trace.push({ t: next.tick, x: p.ball.x, y: p.ball.y });
		}
	}
	return { state: next, events, error: null, trace };
}

const api = {
	RULES_VERSION, DT, MAX_ROLL_TICKS, STOP_SPEED, CAPTURE_SPEED, BALL_R, CUP_R,
	MAX_POWER, INVALID_TIME_PENALTY_MS,
	mulberry32, hashStr, hashState, stableStringify, q, moverPos, inZone,
	makeState, invalidReason, legalActions, step, holeScore,
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
else { window.PG = window.PG || {}; window.PG.rules = api; }
})();
