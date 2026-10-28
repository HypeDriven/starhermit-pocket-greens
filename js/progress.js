'use strict';
(function () {

// Pocket Greens — the progression save, pure (engine client and node tests share it).
// The browser build's checksummed cloud document, unchanged:
//   { version 2, journey: { unlocked, stars: { stageId: best strokes } },
//     achievements: { key: unlock time ms }, mastery: { holesCompleted, noPenaltyHoles,
//     bestDaily, underParStreak }, checksum }
// with the FNV checksum over { v, journey, achievements, mastery } (rules.js hashStr of
// stableStringify). On the engine it is the game's save (starhermit:storage `saves`);
// the browser build's cloud slot (the JS SDK's save.json) holds the same document and
// is merged in once. Also: the achievements, the round recording (bootstrap.js
// awardProgress) and the browser build's per-player settings migration.

const RULES = (typeof module !== 'undefined' && module.exports) ? require('./rules') : globalThis.PG.rules;

const DEFAULT_PROGRESS = {
	version: 2,
	journey: { unlocked: 1, stars: {} },
	achievements: {},
	mastery: { holesCompleted: 0, noPenaltyHoles: 0, bestDaily: null, underParStreak: 0 },
};

const ACHIEVEMENTS = [
	{ key: 'first_hole', name: 'First Cup', desc: 'Hole out for the first time.' },
	{ key: 'mechanic_master', name: 'Course Mechanic', desc: 'Complete every Learn lesson.' },
	{ key: 'streak_3', name: 'On a Roll', desc: 'Hole out on three holes in a row under par.' },
	{ key: 'journey_half', name: 'Half the Garden', desc: 'Complete 22 Journey stages.' },
	{ key: 'century', name: 'Century of Putts', desc: 'Complete 100 holes across all modes.' },
];

function clone(v) { return JSON.parse(JSON.stringify(v)); }
function blank() { return clone(DEFAULT_PROGRESS); }

function checksum(doc) {
	return RULES.hashStr(RULES.stableStringify({ v: doc.version, journey: doc.journey, achievements: doc.achievements, mastery: doc.mastery }));
}
function seal(doc) { doc.checksum = checksum(doc); return doc; }

/** A save document (object or JSON text) when its version and checksum hold, else null. */
function parse(json) {
	try {
		const doc = typeof json === 'string' ? JSON.parse(json) : json;
		if (!doc || typeof doc !== 'object' || doc.version !== DEFAULT_PROGRESS.version) return null;
		if (doc.checksum !== checksum(doc)) return null;
		return doc;
	} catch (e) { return null; }
}

// Neither side's progress is dropped: journey unlocks take the further point, per-stage
// best strokes the lower count, achievements the earliest unlock, lifetime counters the
// larger value, best daily the lower total; the under-par streak is the local one.
function merge(remote, local) {
	const r = remote || {}, l = local || {};
	const obj = (v) => (v && typeof v === 'object' ? v : {});
	const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);
	const stars = Object.assign({}, obj(obj(r.journey).stars));
	for (const [k, v] of Object.entries(obj(obj(l.journey).stars))) stars[k] = stars[k] ? Math.min(stars[k], v) : v;
	const achievements = Object.assign({}, obj(r.achievements));
	for (const [k, v] of Object.entries(obj(l.achievements))) achievements[k] = achievements[k] ? Math.min(achievements[k], v) : v;
	const rm = obj(r.mastery), lm = obj(l.mastery);
	const dailies = [rm.bestDaily, lm.bestDaily].filter(x => typeof x === 'number');
	return seal({
		version: DEFAULT_PROGRESS.version,
		journey: { unlocked: Math.max(num(obj(r.journey).unlocked), num(obj(l.journey).unlocked), 1), stars },
		achievements,
		mastery: {
			holesCompleted: Math.max(num(rm.holesCompleted), num(lm.holesCompleted)),
			noPenaltyHoles: Math.max(num(rm.noPenaltyHoles), num(lm.noPenaltyHoles)),
			bestDaily: dailies.length ? Math.min.apply(null, dailies) : null,
			underParStreak: num(lm.underParStreak),
		},
	});
}

function same(a, b) { return checksum(a) === checksum(b); }

function unlock(progress, key, nowMs) {
	if (progress.achievements[key]) return false;
	if (!ACHIEVEMENTS.find(a => a.key === key)) return false;
	progress.achievements[key] = nowMs;
	return true;
}

// Holes holed out under par count consecutively across rounds; a hole at par or worse
// resets the streak; a round without a completed hole leaves it. 'On a Roll' at three.
function recordHoleStreak(progress, holes, total, parTotal, nowMs) {
	if (holes > 0 && total < parTotal) progress.mastery.underParStreak = (progress.mastery.underParStreak || 0) + holes;
	else if (holes > 0) progress.mastery.underParStreak = 0;
	if ((progress.mastery.underParStreak || 0) >= 3 && unlock(progress, 'streak_3', nowMs)) return 'On a Roll';
	return null;
}

/**
 * Records a finished round (bootstrap.js awardProgress). `o`: { mode, result (the
 * session's sorted results), mine (the local player's row), holedAny, holes (the
 * session's courses), journeyIndex (stage index in JOURNEY or -1), journeyLength,
 * lessonId (Learn, when the hole was holed), lessonsDone (completed lesson ids after
 * this one), lessonCount, nowMs }. Mutates `p`; returns the newly unlocked names.
 */
function record(p, o) {
	const unlocked = [];
	const mine = o.mine;
	if (o.holedAny && unlock(p, 'first_hole', o.nowMs)) unlocked.push('First Cup');
	p.mastery.holesCompleted += mine.holes || 0;
	if (p.mastery.holesCompleted >= 100 && unlock(p, 'century', o.nowMs)) unlocked.push('Century of Putts');
	if (mine.penalties === 0) p.mastery.noPenaltyHoles += mine.holes || 0;
	const parTotal = o.holes.reduce((a, h) => a + h.par, 0);
	const streak = recordHoleStreak(p, mine.holes || 0, mine.total, parTotal, o.nowMs);
	if (streak) unlocked.push(streak);
	if (o.mode === 'journey') {
		const stage = o.holes[0].id;
		if (!p.journey.stars[stage] || mine.total < p.journey.stars[stage]) p.journey.stars[stage] = mine.total;
		if (o.journeyIndex >= 0 && o.journeyIndex + 2 > p.journey.unlocked) p.journey.unlocked = Math.min(o.journeyLength, o.journeyIndex + 2);
		if (Object.keys(p.journey.stars).length >= 22 && unlock(p, 'journey_half', o.nowMs)) unlocked.push('Half the Garden');
	}
	if (o.mode === 'learn' && o.lessonId && o.holedAny && o.lessonsDone >= o.lessonCount) {
		if (unlock(p, 'mechanic_master', o.nowMs)) unlocked.push('Course Mechanic');
	}
	if (o.mode === 'daily' && (!p.mastery.bestDaily || mine.total < p.mastery.bestDaily)) p.mastery.bestDaily = mine.total;
	seal(p);
	return unlocked;
}

// ---------- the browser build's per-player settings (settings KV) ----------
// Keys it wrote: audio, graphics, controls, tutorial. The runtime's Options own volumes,
// mute, graphics, reduced motion, high contrast, text size and vibration; the game's own
// options carried over are the sound captions, the colour-vision palette and the
// completed lessons.
const LEGACY_KEYS = ['audio', 'graphics', 'controls', 'tutorial'];
const PALETTES = ['default', 'deuteranopia', 'protanopia', 'tritanopia'];
const GAME_SETTINGS = { captions: false, palette: 'default', lessons: {} };

/** A valid value for one of the game's settings, else undefined. */
function checkSetting(key, v) {
	if (key === 'captions') return typeof v === 'boolean' ? v : undefined;
	if (key === 'palette') return PALETTES.indexOf(v) >= 0 ? v : undefined;
	if (key === 'lessons') {
		if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
		const out = {};
		for (const k of Object.keys(v)) if (v[k] === true && /^[a-z0-9-]{1,32}$/.test(k)) out[k] = true;
		return out;
	}
	return undefined;
}

/** The game's settings found in the browser build's per-player settings. */
function gameSettingsFrom(old) {
	const o = old && typeof old === 'object' ? old : {};
	const out = {};
	const cap = checkSetting('captions', o.audio && o.audio.captions);
	if (cap !== undefined) out.captions = cap;
	const pal = checkSetting('palette', o.graphics && o.graphics.palette);
	if (pal !== undefined) out.palette = pal;
	const les = checkSetting('lessons', o.tutorial && o.tutorial.completed);
	if (les !== undefined && Object.keys(les).length) out.lessons = les;
	return out;
}

const api = {
	DEFAULT_PROGRESS, ACHIEVEMENTS, LEGACY_KEYS, PALETTES, GAME_SETTINGS,
	blank, checksum, seal, parse, merge, same, unlock, recordHoleStreak, record,
	checkSetting, gameSettingsFrom,
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
else { globalThis.PG = globalThis.PG || {}; globalThis.PG.progress = api; }
})();
