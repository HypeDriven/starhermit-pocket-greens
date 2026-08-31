'use strict';
(function () {

// Pocket Greens — content: versioned levels, themes, tutorials, validation metadata.
// Content entries: { id, seed, par, cap, theme, tutorial, mechanics, course }.
// Course geometry lives here; the rules engine simulates it without knowing content semantics.

const RULES = (typeof module !== 'undefined' && module.exports) ? require('./rules') : window.PG.rules;

const CONTENT_VERSION = 2;

const THEMES = [
	{
		id: 'garden', name: 'Morning Garden',
		palette: { green: 0x5d9c59, rough: 0x74b06a, wall: 0x8a6b4a, water: 0x3f7fbf, sand: 0xd9c07a, cup: 0x1d2b1a, ball: 0xf5f6fa, obstacle: 0xa05545, mover: 0xc9783f, sky: 0xbfd9a8 },
		ambience: 'birds',
	},
	{
		id: 'meadow', name: 'High Meadow',
		palette: { green: 0x6fa860, rough: 0x87bd6e, wall: 0x7d7458, water: 0x4a90b8, sand: 0xdccf8f, cup: 0x22301c, ball: 0xfdfdf5, obstacle: 0x96795a, mover: 0xb08850, sky: 0xcfe3b0 },
		ambience: 'wind',
	},
	{
		id: 'pond', name: 'Pocket Pond',
		palette: { green: 0x4f9a6b, rough: 0x63ae7c, wall: 0x6b5d4f, water: 0x2f6fa8, sand: 0xcdb871, cup: 0x14251c, ball: 0xf2f6f0, obstacle: 0x5d7a8c, mover: 0x548a96, sky: 0x9fc7c0 },
		ambience: 'water',
	},
	{
		id: 'dusk', name: 'Dusk Lanterns',
		palette: { green: 0x4a7a52, rough: 0x5c8f61, wall: 0x5d4a3f, water: 0x274a7a, sand: 0xbfa468, cup: 0x101a12, ball: 0xf8f2e0, obstacle: 0x8c5a78, mover: 0xd08a3f, sky: 0x584a70 },
		ambience: 'crickets',
	},
	{
		id: 'frost', name: 'First Frost',
		palette: { green: 0x7fa8a0, rough: 0x93bab2, wall: 0x8d9aa5, water: 0x5f9cc9, sand: 0xd8d8cf, cup: 0x1c2a28, ball: 0xffffff, obstacle: 0x7a8fa8, mover: 0x9fb6cc, sky: 0xd6e4ea },
		ambience: 'still',
	},
];

function getTheme(id) { return THEMES.find(t => t.id === id) || THEMES[0]; }

// ---------- course primitives ----------

function rect(x, y, w, h, extra) { return Object.assign({ type: 'rect', x, y, w, h }, extra || {}); }
function circle(x, y, r, extra) { return Object.assign({ type: 'circle', x, y, r }, extra || {}); }
function mover(x, y, r, axis, amp, period, phase) { return { type: 'mover', x, y, r, axis, amp, period, phase: phase || 0 }; }

function course(id, o) {
	return Object.assign({
		id, contentVersion: CONTENT_VERSION,
		w: 18, h: 10,
		start: { x: 2, y: 5 }, cup: { x: 16, y: 5 },
		walls: [], obstacles: [], water: [], sand: [], movers: [],
	}, o);
}

// ---------- authored holes (mechanics introduced in isolation, then combined) ----------

const AUTHORED = [
	course('j01', { par: 2, theme: 'garden', mechanics: ['aim', 'power'], tutorial: 'drive' }),
	course('j02', {
		par: 3, theme: 'garden', mechanics: ['walls'], tutorial: 'bank',
		start: { x: 2, y: 2 }, cup: { x: 16, y: 8 },
		walls: [rect(8, 0, 0.6, 7)],
	}),
	course('j03', {
		par: 3, theme: 'garden', mechanics: ['obstacles'],
		walls: [rect(8, 3, 0.6, 4)], obstacles: [circle(9, 2, 0.5), circle(9, 8, 0.5)],
	}),
	course('j04', {
		par: 3, theme: 'pond', mechanics: ['water'], tutorial: 'water',
		water: [rect(7, 0, 3, 5.6)], cup: { x: 15, y: 5 },
	}),
	course('j05', {
		par: 3, theme: 'meadow', mechanics: ['sand'],
		sand: [rect(6, 2, 5, 6)],
	}),
	course('j06', {
		par: 3, theme: 'pond', mechanics: ['water', 'walls'], tutorial: 'carry',
		water: [rect(5, 3.6, 8, 3)], walls: [rect(5, 0, 0.6, 2), rect(12.4, 7.6, 0.6, 2.4)],
		cup: { x: 15, y: 5 },
	}),
	course('j07', {
		par: 4, theme: 'meadow', mechanics: ['movers'], tutorial: 'movers',
		movers: [mover(9, 5, 0.5, 'y', 3, 4)],
	}),
	course('j08', {
		par: 4, theme: 'garden', mechanics: ['obstacles', 'sand'],
		obstacles: [circle(7, 3, 0.6), circle(7, 7, 0.6), circle(11, 5, 0.6)],
		sand: [rect(9, 0, 2, 3)],
	}),
	course('j09', {
		par: 4, theme: 'pond', mechanics: ['water', 'movers'],
		water: [rect(6, 0, 2.5, 7)], movers: [mover(11, 5, 0.45, 'x', 2.5, 3.5)],
		cup: { x: 15.5, y: 8 },
	}),
	course('j10', {
		par: 4, theme: 'dusk', mechanics: ['walls', 'obstacles', 'water'],
		walls: [rect(5, 0, 0.6, 6), rect(12, 4, 0.6, 6)],
		obstacles: [circle(8.5, 5, 0.7)], water: [rect(8, 0, 1.5, 2.5)],
		cup: { x: 16, y: 2 },
	}),
	course('j11', {
		par: 4, theme: 'dusk', mechanics: ['movers', 'sand'],
		movers: [mover(6, 5, 0.4, 'y', 3.5, 3), mover(12, 5, 0.4, 'y', 3.5, 3, 0.5)],
		sand: [rect(8, 3.5, 2.5, 3)],
	}),
	course('j12', {
		par: 5, theme: 'frost', mechanics: ['water', 'walls', 'movers'],
		walls: [rect(4, 4, 0.6, 6)], water: [rect(9, 0, 3, 4), rect(9, 6, 3, 4)],
		movers: [mover(10.5, 5, 0.4, 'x', 1.2, 2.5)], cup: { x: 16, y: 5 },
	}),
];

// ---------- procedural stages (seeded, versioned) ----------

// Difficulty is derived from obstacle count, mover speed, water coverage, and cup distance —
// not merely larger numbers. `tier` 1..4 maps to Journey chapters.
function generateCourse(seed, tier, index) {
	const r = RULES.mulberry32(RULES.hashStr('pgc:' + seed + ':' + index));
	const id = 'g' + String(index + 1).padStart(2, '0');
	const theme = THEMES[Math.floor(r() * THEMES.length)].id;
	const c = course(id, {
		seed: String(seed), theme,
		par: 3 + (tier >= 3 ? 1 : 0),
		start: { x: 1.6 + r() * 1.2, y: 2 + r() * 6 },
		cup: { x: 15.5 + r() * 1.5, y: 2 + r() * 6 },
		mechanics: [],
	});
	const n = tier + Math.floor(r() * 2);
	for (let i = 0; i < n; i++) {
		const kind = r();
		const x = 5 + r() * 8, y = 1.5 + r() * 7;
		if (kind < 0.34) {
			c.obstacles.push(circle(x, y, 0.4 + r() * 0.3));
			if (!c.mechanics.includes('obstacles')) c.mechanics.push('obstacles');
		} else if (kind < 0.58) {
			const vert = r() < 0.5;
			c.walls.push(vert ? rect(x, y - 2, 0.6, 4) : rect(x - 2, y, 4, 0.6));
			if (!c.mechanics.includes('walls')) c.mechanics.push('walls');
		} else if (kind < 0.78 && tier >= 2) {
			c.water.push(rect(x - 1, 0, 2 + r() * 1.5, 3.5 + r() * 2));
			if (!c.mechanics.includes('water')) c.mechanics.push('water');
		} else if (tier >= 3) {
			c.movers.push(mover(x, y, 0.4, r() < 0.5 ? 'x' : 'y', 1.5 + r() * 2, 2.5 + r() * 2, r()));
			if (!c.mechanics.includes('movers')) c.mechanics.push('movers');
		} else {
			c.sand.push(rect(x - 1.5, y - 1, 3, 2));
			if (!c.mechanics.includes('sand')) c.mechanics.push('sand');
		}
	}
	return c;
}

// Journey: 12 authored + 32 seeded procedural = 44 stages across four chapters.
const JOURNEY_SEED = 'journey-v2';
const JOURNEY = AUTHORED.slice();
for (let i = 0; i < 32; i++) {
	const tier = 1 + Math.min(3, Math.floor(i / 8));
	JOURNEY.push(generateCourse(JOURNEY_SEED, tier, i));
}

// ---------- tutorials (Learn mode: one rule at a time, player must perform it) ----------

const TUTORIALS = [
	{
		id: 'drive', title: 'Aim and Strike',
		steps: [
			{ text: 'Drag back from the ball (or use ←/→ to aim, ↑/↓ for power), then release or press Space to strike.', require: 'strike' },
			{ text: 'Hole out. Softer shots are safer near the cup — fast balls lip out.', require: 'holed' },
		],
	},
	{
		id: 'bank', title: 'Bank Shots',
		steps: [{ text: 'The wall blocks the direct line. Bounce the ball off a wall to reach the cup.', require: 'holed' }],
	},
	{
		id: 'water', title: 'Water Hazards',
		steps: [{ text: 'Water costs a penalty stroke and returns the ball. Carry it cleanly or play around.', require: 'holed' }],
	},
	{
		id: 'carry', title: 'Carry the Gap',
		steps: [{ text: 'Combine aim, power, and walls to cross the water in the middle.', require: 'holed' }],
	},
	{
		id: 'movers', title: 'Moving Obstacles',
		steps: [{ text: 'The keeper sweeps back and forth. Time your stroke to pass — or go over its route.', require: 'holed' }],
	},
];

// ---------- daily challenge ----------

// One shared seed and ruleset per UTC day; immutable after publication.
function dailySeed(dateUtc) {
	const d = dateUtc ? new Date(dateUtc) : new Date();
	const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 86400000;
	return 'daily-' + Math.floor(day);
}

function dailyCourse(dateUtc) {
	const seed = dailySeed(dateUtc);
	const c = generateCourse(seed, 3, 0);
	c.id = 'daily';
	c.seed = seed;
	c.par = 4;
	c.theme = THEMES[RULES.hashStr(seed) % THEMES.length].id;
	return c;
}

// ---------- challenges ----------

const CHALLENGES = [
	{ id: 'ch-putter', name: 'Putter Only', desc: 'Power capped at 40%. Hole out anyway.', maxPower: 40, course: AUTHORED[0] },
	{ id: 'ch-two-move', name: 'Two Moves', desc: 'Finish j03 in at most 2 strokes.', strokeLimit: 2, course: AUTHORED[2] },
	{ id: 'ch-speed', name: 'Speed Green', desc: 'Finish j06 with a total elapsed time under 20 simulated seconds.', timeLimitTicks: 2400, course: AUTHORED[5] },
	{ id: 'ch-needle', name: 'Thread the Needle', desc: 'j12 with no water penalties allowed.', noPenalties: true, course: AUTHORED[11] },
	{ id: 'ch-iron', name: 'Iron Bounce', desc: 'j10 — every stroke must touch a wall at least once.', requireBounce: true, course: AUTHORED[9] },
];

// ---------- validators ----------

// Basic legality: bounds, non-overlap at start, sane cup.
function validateLegality(c) {
	const errs = [];
	if (!(c.w > 4 && c.h > 4)) errs.push('course too small');
	const inside = (p) => p.x > 0.5 && p.x < c.w - 0.5 && p.y > 0.5 && p.y < c.h - 0.5;
	if (!inside(c.start)) errs.push('start out of bounds');
	if (!inside(c.cup)) errs.push('cup out of bounds');
	for (const z of c.water) if (RULES.inZone(c.start.x, c.start.y, z)) errs.push('start in water');
	for (const o of c.obstacles) {
		const dx = c.start.x - o.x, dy = c.start.y - o.y;
		if (o.type === 'circle' && dx * dx + dy * dy < (o.r + 0.4) * (o.r + 0.4)) errs.push('start inside obstacle');
	}
	if (!(c.par >= 1 && c.par <= 8)) errs.push('par out of range');
	return errs;
}

// Reachability: seeded solver tries a spread of angle/power pairs and proves some stroke
// sequence holes out within the cap. Also proves bounded duration (every stroke resolves).
function validateReachable(c, tries) {
	const attempts = tries || 260;
	const r = RULES.mulberry32(RULES.hashStr('solve:' + c.id + ':' + (c.seed || '')));
	for (let t = 0; t < attempts; t++) {
		let st = RULES.makeState('solve', c, ['p1']);
		let ok = false;
		// aim mostly at the cup; sometimes route via a random waypoint (banks, dry corridors)
		const wp = { x: 2 + r() * (c.w - 4), y: 1 + r() * (c.h - 2) };
		for (let s = 0; s < st.cap && !ok; s++) {
			const b = st.players[0].ball;
			const target = (s === 0 && t % 3 === 2) ? wp : c.cup;
			const aim = Math.atan2(target.y - b.y, target.x - b.x);
			const angle = aim + (r() - 0.5) * (t < 40 ? 0.12 : 0.5);
			const power = 20 + r() * 75;
			const res = RULES.step(st, c, { type: 'strike', angle, power, by: 'p1' });
			if (res.error) return { ok: false, error: 'illegal strike from solver: ' + res.error };
			st = res.state;
			for (const e of res.events) if (e.type === 'holed') ok = true;
			if (st.terminal && !ok) break; // capped out — this line of play failed, try another
			if (!Number.isFinite(st.players[0].ball.x) || !Number.isFinite(st.players[0].ball.y)) {
				return { ok: false, error: 'NaN physics' };
			}
		}
		if (ok) return { ok: true, strokes: st.players[0].strokes };
	}
	return { ok: false, error: 'no solution found in ' + attempts + ' attempts' };
}

function validateAll() {
	const report = [];
	const all = JOURNEY.concat(CHALLENGES.map(ch => ch.course));
	for (const c of all) {
		const legality = validateLegality(c);
		const reach = legality.length ? { ok: false, error: 'skipped' } : validateReachable(c);
		report.push({ id: c.id, legality, reachable: reach.ok, error: reach.error || null });
	}
	return report;
}

const api = {
	CONTENT_VERSION, THEMES, getTheme,
	AUTHORED, JOURNEY, TUTORIALS, CHALLENGES,
	dailySeed, dailyCourse, generateCourse,
	validateLegality, validateReachable, validateAll,
	getLevel(id) { return JOURNEY.find(c => c.id === id) || null; },
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
else { window.PG = window.PG || {}; window.PG.content = api; }
})();
