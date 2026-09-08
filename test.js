'use strict';

// Pocket Greens — offline test suite: rules unit tests, determinism/replay property tests,
// content validators, fuzz, golden sessions, and a server smoke test.

const assert = require('assert');
const path = require('path');
const RULES = require('./rules');
const CONTENT = require('./content');
const SESSION = require('./session');

let passed = 0;
const failures = [];
function test(name, fn) {
	try { fn(); passed++; console.log('ok - ' + name); }
	catch (e) { failures.push({ name, e }); console.error('FAIL - ' + name + ': ' + e.message); }
}

const simple = CONTENT.AUTHORED[0];

// ---------- rules: legality & invalid-action reasons ----------

test('legal actions are exposed in aim phase', () => {
	const st = RULES.makeState('t', simple, ['p1']);
	const acts = RULES.legalActions(st);
	assert.strictEqual(acts.length, 1);
	assert.strictEqual(acts[0].type, 'strike');
	assert.strictEqual(acts[0].by, 'p1');
});

test('invalid-action reasons', () => {
	const st = RULES.makeState('t', simple, ['p1']);
	assert.strictEqual(RULES.invalidReason(st, null), 'malformed-command');
	assert.strictEqual(RULES.invalidReason(st, { type: 'strike', angle: 0, power: 0 }), 'power-out-of-range');
	assert.strictEqual(RULES.invalidReason(st, { type: 'strike', angle: 0, power: 101 }), 'power-out-of-range');
	assert.strictEqual(RULES.invalidReason(st, { type: 'strike', angle: NaN, power: 50 }), 'bad-stroke-params');
	assert.strictEqual(RULES.invalidReason(st, { type: 'strike', angle: 0, power: 50, by: 'other' }), 'out-of-turn');
	assert.strictEqual(RULES.invalidReason(st, { type: 'warp' }), 'unknown-command');
});

test('serialization round-trip', () => {
	const st = RULES.makeState('t', simple, ['p1', 'p2']);
	const back = JSON.parse(JSON.stringify(st));
	assert.deepStrictEqual(back, st);
	assert.strictEqual(RULES.hashState(back), RULES.hashState(st));
});

// ---------- rules: simulation ----------

test('strike consumes a stroke and resolves to rest', () => {
	const st = RULES.makeState('t', simple, ['p1']);
	const res = RULES.step(st, simple, { type: 'strike', angle: 0, power: 40, by: 'p1' });
	assert.strictEqual(res.error, null);
	assert.strictEqual(res.state.players[0].strokes, 1);
	assert.notStrictEqual(res.state.phase, 'roll');
	assert.ok(res.trace.length > 1);
	assert.strictEqual(res.state.tick, st.tick + res.trace.length - 1);
	assert.ok(res.state.players[0].ball.vx === 0 && res.state.players[0].ball.vy === 0);
});

test('input state is never mutated', () => {
	const st = RULES.makeState('t', simple, ['p1']);
	const before = JSON.stringify(st);
	RULES.step(st, simple, { type: 'strike', angle: 0.3, power: 60, by: 'p1' });
	assert.strictEqual(JSON.stringify(st), before);
});

test('straight aimed stroke holes out on the tutorial hole', () => {
	let st = RULES.makeState('t', simple, ['p1']);
	for (let i = 0; i < 6 && !st.terminal; i++) {
		const b = st.players[0].ball;
		const angle = Math.atan2(simple.cup.y - b.y, simple.cup.x - b.x);
		const dist = Math.hypot(simple.cup.x - b.x, simple.cup.y - b.y);
		st = RULES.step(st, simple, { type: 'strike', angle, power: Math.min(90, dist * 12), by: 'p1' }).state;
	}
	assert.ok(st.terminal, 'should finish');
	assert.ok(st.players[0].holed);
	assert.ok(st.players[0].strokes + st.players[0].penalties <= st.cap);
});

test('water hazard costs a penalty and resets the ball', () => {
	const pond = CONTENT.AUTHORED[3]; // j04: water across the middle
	let st = RULES.makeState('t', pond, ['p1']);
	// blast straight through the water
	const res = RULES.step(st, pond, { type: 'strike', angle: 0, power: 100, by: 'p1' });
	const splashed = res.events.some(e => e.type === 'splash');
	if (splashed) {
		const p = res.state.players[0];
		assert.strictEqual(p.penalties, 1);
		assert.deepStrictEqual({ x: p.ball.x, y: p.ball.y }, { x: pond.start.x, y: pond.start.y });
	} else {
		// if it carried the water cleanly at full power, it must not have gained a penalty
		assert.strictEqual(res.state.players[0].penalties, 0);
	}
});

test('movers are a pure function of tick', () => {
	const m = CONTENT.AUTHORED[6].movers[0];
	for (const t of [1, 100, 12345]) {
		assert.deepStrictEqual(RULES.moverPos(m, t), RULES.moverPos(m, t));
	}
});

test('stroke cap ends the hole', () => {
	const c = Object.assign({}, simple, { cap: 2 });
	let st = RULES.makeState('t', c, ['p1']);
	for (let i = 0; i < 4 && !st.terminal; i++) {
		st = RULES.step(st, c, { type: 'strike', angle: Math.PI, power: 5, by: 'p1' }).state; // dribble away from cup
	}
	assert.ok(st.terminal);
	assert.strictEqual(st.terminal.reason, 'completed');
	assert.strictEqual(RULES.holeScore(st, st.players[0]), 2);
});

test('two players alternate and terminal results are ordered', () => {
	let st = RULES.makeState('t', simple, ['a', 'b']);
	let guard = 0;
	while (!st.terminal && guard++ < 40) {
		const me = st.players[st.currentPlayer];
		const angle = Math.atan2(simple.cup.y - me.ball.y, simple.cup.x - me.ball.x);
		const dist = Math.hypot(simple.cup.x - me.ball.x, simple.cup.y - me.ball.y);
		st = RULES.step(st, simple, { type: 'strike', angle, power: Math.min(85, dist * 12), by: me.id }).state;
	}
	assert.ok(st.terminal);
	assert.strictEqual(st.terminal.results.length, 2);
	assert.ok(st.terminal.results[0].total <= st.terminal.results[1].total);
});

// ---------- determinism / replay property ----------

test('same seed and commands produce identical state hashes', () => {
	function run() {
		let st = RULES.makeState('det', CONTENT.AUTHORED[9], ['p1']);
		const r = RULES.mulberry32(99);
		for (let i = 0; i < 8 && !st.terminal; i++) {
			st = RULES.step(st, CONTENT.AUTHORED[9], { type: 'strike', angle: r() * Math.PI * 2, power: 20 + r() * 70, by: 'p1' }).state;
		}
		return RULES.hashState(st);
	}
	assert.strictEqual(run(), run());
});

test('session replay envelope verifies', () => {
	const sess = SESSION.newSession({ seed: 'rp', holes: [CONTENT.AUTHORED[2]], players: ['you'] });
	const r = RULES.mulberry32(7);
	for (let i = 0; i < 10 && !sess.finished; i++) {
		const me = sess.state.players[sess.state.currentPlayer];
		const c = sess.holes[sess.holeIndex];
		const angle = Math.atan2(c.cup.y - me.ball.y, c.cup.x - me.ball.x) + (r() - 0.5) * 0.4;
		SESSION.applyCommand(sess, { type: 'strike', angle, power: 30 + r() * 55, by: me.id });
	}
	const env = SESSION.replayEnvelope(sess);
	assert.strictEqual(env.schema, SESSION.REPLAY_SCHEMA);
	assert.ok(env.commands.length > 0);
	assert.ok(SESSION.verifyReplay(sess, env).ok);
});

// ---------- fuzz ----------

test('fuzz: malformed commands never throw, hang, or corrupt state', () => {
	const junk = [null, undefined, 42, 'strike', {}, { type: 1 }, { type: 'strike' },
		{ type: 'strike', angle: Infinity, power: 50 }, { type: 'strike', angle: 0, power: -5 },
		{ type: 'strike', angle: 1e308, power: 1e308 }, { type: 'x'.repeat(10000) }];
	let st = RULES.makeState('fz', CONTENT.AUTHORED[11], ['p1']);
	for (let round = 0; round < 200; round++) {
		const cmd = junk[round % junk.length];
		const res = RULES.step(st, CONTENT.AUTHORED[11], cmd);
		assert.ok(res.error, 'junk must be rejected: ' + JSON.stringify(cmd));
		assert.ok(Number.isFinite(res.state.tick));
	}
	// valid random strikes: no NaN, always terminates
	const r = RULES.mulberry32(3);
	for (let i = 0; i < 30 && !st.terminal; i++) {
		const res = RULES.step(st, CONTENT.AUTHORED[11], { type: 'strike', angle: r() * 6.28, power: 1 + r() * 99, by: 'p1' });
		const b = res.state.players[res.state.currentPlayer].ball;
		assert.ok(Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.vx) && Number.isFinite(b.vy));
	}
});

// ---------- content validators ----------

test('all content passes legality validation', () => {
	const all = CONTENT.JOURNEY.concat(CONTENT.CHALLENGES.map(c => c.course));
	assert.ok(CONTENT.JOURNEY.length >= 40, 'at least 40 stages: ' + CONTENT.JOURNEY.length);
	for (const c of all) {
		const errs = CONTENT.validateLegality(c);
		assert.deepStrictEqual(errs, [], c.id + ': ' + errs.join(','));
	}
});

test('all content is reachable and bounded (solver)', () => {
	const all = CONTENT.JOURNEY.concat(CONTENT.CHALLENGES.map(c => c.course));
	const bad = [];
	for (const c of all) {
		const r = CONTENT.validateReachable(c, 80);
		if (!r.ok) bad.push(c.id + ': ' + r.error);
	}
	assert.deepStrictEqual(bad, [], bad.join(' | '));
});

test('daily seed is stable per UTC day and valid', () => {
	const d = Date.UTC(2026, 0, 15);
	assert.strictEqual(CONTENT.dailySeed(d), CONTENT.dailySeed(d));
	assert.notStrictEqual(CONTENT.dailySeed(d), CONTENT.dailySeed(d + 86400000));
	const c = CONTENT.dailyCourse(d);
	assert.deepStrictEqual(CONTENT.validateLegality(c), []);
});

test('five themes exist with complete palettes', () => {
	assert.strictEqual(CONTENT.THEMES.length, 5);
	for (const t of CONTENT.THEMES) {
		for (const k of ['green', 'wall', 'water', 'sand', 'cup', 'ball', 'sky']) assert.ok(t.palette[k] != null, t.id + '.' + k);
	}
});

// ---------- golden sessions ----------

test('golden: interrupted and resumed session preserves totals', () => {
	const sess = SESSION.newSession({ seed: 'gold', holes: [CONTENT.AUTHORED[0], CONTENT.AUTHORED[1]], players: ['you'] });
	const snap = SESSION.snapshot(sess);
	const resumed = SESSION.newSession({ seed: 'gold', holes: [CONTENT.AUTHORED[0], CONTENT.AUTHORED[1]], players: ['you'] });
	resumed.state = snap;
	assert.strictEqual(RULES.hashState(resumed.state), RULES.hashState(sess.state));
});

test('golden: undo restores the exact prior state (practice)', () => {
	const sess = SESSION.newSession({ seed: 'u', holes: [CONTENT.AUTHORED[0]], players: ['you'], mode: 'practice' });
	const h0 = RULES.hashState(sess.state);
	SESSION.applyCommand(sess, { type: 'strike', angle: 0.2, power: 50 });
	assert.notStrictEqual(RULES.hashState(sess.state), h0);
	assert.ok(SESSION.undo(sess));
	assert.strictEqual(RULES.hashState(sess.state), h0);
});

test('golden: AI strike is deterministic', () => {
	const a = SESSION.newSession({ seed: 'ai', holes: [CONTENT.AUTHORED[6]], players: ['you', 'ai'] });
	const b = SESSION.newSession({ seed: 'ai', holes: [CONTENT.AUTHORED[6]], players: ['you', 'ai'] });
	assert.deepStrictEqual(SESSION.aiStrike(a, 'ai'), SESSION.aiStrike(b, 'ai'));
});

// ---------- server smoke test ----------

async function serverTests() {
	const server = require('./server');
	await new Promise(r => server.listen(0, r));
	const port = server.address().port;
	const base = 'http://127.0.0.1:' + port;

	const t = await (await fetch(base + '/api/v1/time')).json();
	assert.ok(typeof t.now === 'number');

	const idx = await (await fetch(base + '/')).text();
	assert.ok(idx.includes('Pocket Greens'));

	// static serving must not escape the game root. fetch() normalises "/.." away, so the
	// raw path check goes over a hand-built request; the boundary predicate is asserted
	// directly because a sibling escape resolves to a path that simply does not exist here.
	const rawGet = (rawPath) => new Promise((resolve, reject) => {
		const req = require('http').request({ host: '127.0.0.1', port, method: 'GET', path: rawPath },
			(r) => { r.resume(); resolve(r.statusCode); });
		req.on('error', reject);
		req.end();
	});
	for (const escape of ['/../../etc/passwd', '/./../../etc/hosts', '/.server-data.json', '/.git/config']) {
		const code = await rawGet(escape);
		assert.strictEqual(code, 403, escape + ' returned ' + code);
	}
	const ROOT = server.ROOT;
	assert.ok(server.isInsideRoot(ROOT));
	assert.ok(server.isInsideRoot(path.join(ROOT, 'index.html')));
	assert.ok(!server.isInsideRoot(ROOT + '-elsewhere/secret.txt'), 'sibling directory must be rejected');
	assert.ok(!server.isInsideRoot('/etc/passwd'));

	const created = await (await fetch(base + '/api/v1/sessions', {
		method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ players: 2 }),
	})).json();
	assert.ok(created.id && created.course);

	// authoritative move: legal strike accepted, out-of-turn rejected, duplicates idempotent
	const cmd = { id: 'c1', type: 'strike', angle: 0, power: 50, by: 'host' };
	const ok = await (await fetch(base + '/api/v1/sessions/' + created.id + '/commands', {
		method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cmd),
	})).json();
	assert.ok(ok.state && ok.state.tick > 1);
	const dup = await (await fetch(base + '/api/v1/sessions/' + created.id + '/commands', {
		method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cmd),
	})).json();
	assert.ok(dup.duplicate);
	const bad = await fetch(base + '/api/v1/sessions/' + created.id + '/commands', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ type: 'strike', angle: 0, power: 50, by: 'host' }),
	});
	assert.strictEqual(bad.status, 422); // out of turn: guest must play next

	// leaderboard validation: impossible and stale-version scores rejected
	const imp = await fetch(base + '/api/v1/leaderboard', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ board: 'daily', seed: 's', score: 0, rulesVersion: RULES.RULES_VERSION, contentVersion: CONTENT.CONTENT_VERSION }),
	});
	assert.strictEqual(imp.status, 422);
	const good = await (await fetch(base + '/api/v1/leaderboard', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ board: 'daily', seed: 's', score: 5, rulesVersion: RULES.RULES_VERSION, contentVersion: CONTENT.CONTENT_VERSION, durationMs: 90000 }),
	})).json();
	assert.ok(good.rank >= 1);

	await new Promise(r => server.close(r));
	console.log('ok - server smoke (time, static, sessions, idempotency, leaderboard)');
	passed++;
}

(async () => {
	try { await serverTests(); }
	catch (e) { failures.push({ name: 'server smoke', e }); console.error('FAIL - server smoke: ' + e.message); }
	console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
	if (failures.length) process.exit(1);
})();
