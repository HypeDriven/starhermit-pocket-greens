// The progression save (js/progress.js): the browser build's checksummed document parses,
// merges (best of both), records rounds and achievements; the old per-player settings carry
// the game's options over. Signed-in paths cannot run here, so their logic is covered here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const P = require('../js/progress.js');
const RULES = require('../js/rules.js');
const CONTENT = require('../js/content.js');

// A document as the browser build's platform.js wrote it (checksum over v/journey/achievements/mastery).
function browserDoc(o) {
  const doc = { version: 2, journey: { unlocked: 3, stars: { j01: 2, j02: 3 } }, achievements: { first_hole: 5 }, mastery: { holesCompleted: 4, noPenaltyHoles: 3, bestDaily: 5, underParStreak: 1 }, ...o };
  doc.checksum = RULES.hashStr(RULES.stableStringify({ v: doc.version, journey: doc.journey, achievements: doc.achievements, mastery: doc.mastery }));
  return doc;
}

test('the browser build\'s cloud document parses (object and JSON text); a bad checksum does not', () => {
  const d = browserDoc();
  assert.ok(P.parse(d));
  assert.ok(P.parse(JSON.stringify(d)));
  assert.equal(P.parse({ ...d, checksum: 1 }), null);
  assert.equal(P.parse({ ...d, version: 1 }), null);
  assert.equal(P.parse('{nope'), null);
});

test('merge keeps the best of both', () => {
  const a = browserDoc();
  const b = browserDoc({ journey: { unlocked: 5, stars: { j01: 1, j04: 3 } }, achievements: { first_hole: 2, century: 9 }, mastery: { holesCompleted: 2, noPenaltyHoles: 9, bestDaily: null, underParStreak: 0 } });
  const m = P.merge(a, b);
  assert.deepEqual(m.journey, { unlocked: 5, stars: { j01: 1, j02: 3, j04: 3 } });
  assert.deepEqual(m.achievements, { first_hole: 2, century: 9 });
  assert.equal(m.mastery.holesCompleted, 4);
  assert.equal(m.mastery.noPenaltyHoles, 9);
  assert.equal(m.mastery.bestDaily, 5);
  assert.ok(P.parse(m));
  assert.ok(P.same(m, P.merge(m, m)));
});

test('record: a journey stage holed under par unlocks the next and First Cup', () => {
  const p = P.blank();
  const holes = [CONTENT.JOURNEY[0]];
  const got = P.record(p, { mode: 'journey', mine: { total: 1, holes: 1, penalties: 0 }, holedAny: true, holes, journeyIndex: 0, journeyLength: 44, nowMs: 7 });
  assert.deepEqual(got, ['First Cup']);
  assert.equal(p.journey.unlocked, 2);
  assert.equal(p.journey.stars.j01, 1);
  assert.equal(p.mastery.holesCompleted, 1);
  assert.equal(p.mastery.underParStreak, 1);
  assert.ok(P.parse(p));
  assert.deepEqual(P.record(p, { mode: 'journey', mine: { total: 3, holes: 1, penalties: 0 }, holedAny: true, holes, journeyIndex: 0, journeyLength: 44, nowMs: 8 }), []);
  assert.equal(p.journey.stars.j01, 1, 'best strokes kept');
  assert.equal(p.mastery.underParStreak, 0, 'over par resets the streak');
});

test('record: the last lesson unlocks Course Mechanic; the daily keeps its best', () => {
  const p = P.blank();
  const hole = [CONTENT.AUTHORED[0]];
  assert.deepEqual(P.record(p, { mode: 'learn', mine: { total: 2, holes: 1, penalties: 0 }, holedAny: true, holes: hole, lessonId: 'movers', lessonsDone: 5, lessonCount: 5, nowMs: 1 }), ['First Cup', 'Course Mechanic']);
  P.record(p, { mode: 'daily', mine: { total: 6, holes: 1, penalties: 1 }, holedAny: true, holes: hole, nowMs: 1 });
  P.record(p, { mode: 'daily', mine: { total: 4, holes: 1, penalties: 0 }, holedAny: true, holes: hole, nowMs: 1 });
  assert.equal(p.mastery.bestDaily, 4);
});

test('streak achievement: three under-par holes in a row, reset on par, idempotent', () => {
  const p = P.blank();
  assert.equal(P.recordHoleStreak(p, 1, 1, 2, 1), null);
  assert.equal(P.recordHoleStreak(p, 1, 2, 2, 1), null);
  assert.equal(P.recordHoleStreak(p, 1, 1, 2, 1), null);
  assert.equal(P.recordHoleStreak(p, 1, 1, 3, 1), null);
  assert.equal(P.recordHoleStreak(p, 1, 1, 2, 1), 'On a Roll');
  assert.equal(P.recordHoleStreak(p, 1, 1, 2, 1), null);
});

test('the browser build\'s per-player settings carry captions, palette and lessons over', () => {
  const old = { audio: { music: 0.2, captions: true }, graphics: { palette: 'tritanopia', gfx: { preset: 'high' } }, controls: { haptics: false }, tutorial: { completed: { drive: true, bank: true, 'x y': true } } };
  assert.deepEqual(P.gameSettingsFrom(old), { captions: true, palette: 'tritanopia', lessons: { drive: true, bank: true } });
  assert.deepEqual(P.gameSettingsFrom({ graphics: { palette: 'neon' } }), {});
  assert.equal(P.checkSetting('captions', 'yes'), undefined);
});
