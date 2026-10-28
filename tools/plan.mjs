// A stroke planner for play scripts: from a rules state, the key presses that
// set up a stroke the way the game does — H (the hint: aim at the cup,
// power clamp(distance × 9, 25, 80)), then ←/→ (0.09 rad; with Shift
// 0.02) and ↑/↓ (5 %; with Shift 1 %) — searched for the stroke that holes
// out, else the one ending closest to the cup without a water penalty.
// The simulation is js/rules.js itself, so the planned strokes are exact.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export const RULES = require('../js/rules.js');
export const CONTENT = require('../js/content.js');
export const SESSION = require('../js/session.js');

/** The hint's aim for the player to play (native/main.ts doHint). */
export function hintAim(state, course) {
  const me = state.players[state.currentPlayer];
  const angle = Math.atan2(course.cup.y - me.ball.y, course.cup.x - me.ball.x);
  const power = Math.min(80, Math.max(25, Math.hypot(course.cup.x - me.ball.x, course.cup.y - me.ball.y) * 9));
  return { angle, power };
}
/** Applies key steps exactly as the game does (aimAction). */
export function applySteps(aim, steps) {
  let { angle, power } = aim;
  for (const s of steps) {
    if (s === 'L') angle -= 0.09; else if (s === 'R') angle += 0.09;
    else if (s === 'l') angle -= 0.02; else if (s === 'r') angle += 0.02;
    else if (s === 'U') power = Math.min(100, power + 5); else if (s === 'D') power = Math.max(1, power - 5);
    else if (s === 'u') power = Math.min(100, power + 1); else if (s === 'd') power = Math.max(1, power - 1);
  }
  return { angle, power };
}
function stepsFor(coarseA, fineA, coarseP, fineP) {
  const out = [];
  for (let i = 0; i < Math.abs(coarseA); i++) out.push(coarseA < 0 ? 'L' : 'R');
  for (let i = 0; i < Math.abs(fineA); i++) out.push(fineA < 0 ? 'l' : 'r');
  for (let i = 0; i < Math.abs(coarseP); i++) out.push(coarseP < 0 ? 'D' : 'U');
  for (let i = 0; i < Math.abs(fineP); i++) out.push(fineP < 0 ? 'd' : 'u');
  return out;
}
/**
 * The best stroke from `state`: { steps, aim, res, holed }. `opts.maxPower` caps the power
 * (Putter Only), `opts.noWater` refuses penalties, `opts.needBounce` wants a wall touch.
 */
export function planStroke(state, course, opts = {}) {
  const base = hintAim(state, course);
  const me = state.players[state.currentPlayer];
  let best = null;
  const score = (res) => {
    const p = res.state.players.find((x) => x.id === me.id);
    const holed = res.events.some((e) => e.type === 'holed' && e.player === me.id);
    const pen = res.events.some((e) => e.type === 'splash');
    const bounce = res.events.some((e) => e.type === 'bounce' && e.material === 'wall');
    if (opts.noWater && pen) return null;
    if (opts.needBounce && !bounce) return null;
    const d = Math.hypot(p.ball.x - course.cup.x, p.ball.y - course.cup.y);
    return { holed, v: holed ? -1000 + res.trace.length / 1e4 : d + (pen ? 50 : 0) };
  };
  for (let ca = -12; ca <= 12; ca++) for (const fa of [0, -2, -1, 1, 2]) for (let cp = -10; cp <= 10; cp++) {
    const steps = stepsFor(ca, fa, cp, 0);
    const aim = applySteps(base, steps);
    if (opts.maxPower && aim.power > opts.maxPower) continue;
    const res = RULES.step(state, course, { type: 'strike', angle: aim.angle, power: aim.power, by: me.id });
    if (res.error) continue;
    const s = score(res);
    if (!s) continue;
    const cost = s.v + steps.length * 1e-4;
    if (!best || cost < best.cost) best = { steps, aim, res, holed: s.holed, cost };
    if (s.holed && steps.length === 0) return best;
  }
  return best;
}

/** Play-script lines for a planned stroke: wait for the aim, H, the steps, Space, wait for the roll. */
export function strokeLines(steps) {
  const out = ['until 900 Drag back', 'frames 10', 'key KeyH 1', 'frames 3'];
  let shift = false;
  const keyOf = { L: 'ArrowLeft', R: 'ArrowRight', U: 'ArrowUp', D: 'ArrowDown', l: 'ArrowLeft', r: 'ArrowRight', u: 'ArrowUp', d: 'ArrowDown' };
  for (const s of steps) {
    const fine = s === s.toLowerCase();
    if (fine && !shift) { out.push('hold ShiftLeft', 'frames 2'); shift = true; }
    if (!fine && shift) { out.push('release ShiftLeft', 'frames 2'); shift = false; }
    out.push(`key ${keyOf[s]} 1`, 'frames 3');
  }
  if (shift) out.push('release ShiftLeft', 'frames 2');
  out.push('key Space 1', 'frames 10');
  return out;
}
