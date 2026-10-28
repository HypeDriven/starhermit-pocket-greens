// Pocket Greens on the StarHermit engine: the entry module (starhermit.txt
// engine.entry), played natively by the StarHermit client and in browsers by
// the engine's web runtime. The rules and physics, content and session are
// the browser build's js/*.js (classic.ts); this module is what its
// bootstrap.js did around them — the game-state machine (title →
// mode-select → countdown → active ⇄ paused → resolving → results →
// progression), the rounds of every mode (Learn, Journey, Daily, Practice
// with the optional AI, Challenges, Hosted), the stroke input (actions, the
// pull-back drag on the course, the power slider), trace playback, hints,
// practice undo, lessons, results with progression, achievements and the
// vs-par leaderboard post, and the lifecycle — with the screens and HUD
// drawn by screens.ts (starhermit:ui), the course by render.ts
// (starhermit:scene) and hosted tables by rooms.ts.
//
// Every stroke still resolves synchronously in js/rules.js (fixed 120 Hz
// physics) before a frame is drawn; its trace plays back on the runtime's
// 60 fixed steps a second (long rolls fast-forward to about 3.5 s, as
// before), events firing at their trace positions, and the countdown and
// AI pacing are counted in the same steps, so a session replays
// identically and play scripts are exact. Held aim and power keys repeat on
// fixed steps too.
import { frame, onFixedUpdate, onPreferencesChange, onQuit, onRender, onResume, onStart, onSuspend, onUpdate, preferences, setFixedRate } from "starhermit:engine";
import { isDown, isKeyDown, onAction, vibrate } from "starhermit:input";
import * as ui from "starhermit:ui";
import { onSessionEnded } from "starhermit:platform";
import * as audio from "./audio.ts";
import { Content, ProgressDoc, Rules, Session, type Challenge, type Command, type Course, type GameEvent, type Sess, type SessionResult, type TracePoint } from "./classic.ts";
import { T } from "./i18n.ts";
import * as platform from "./platform.ts";
import { lookFor } from "./quality.ts";
import * as render from "./render.ts";
import * as rooms from "./rooms.ts";
import { drawScreens } from "./screens.ts";
import { applyContrast, initStyles } from "./style.ts";

export type ScreenName = "title" | "setup" | "lobby" | "game";
export type Overlay = "pause" | "settings" | "help" | "results";
export type Mode = "learn" | "journey" | "daily" | "practice" | "challenge" | "hosted";

const STEP_HZ = 60;
export const settings = platform.settings;
export const app = {
  screen: "title" as ScreenName,
  overlays: [] as Overlay[],
  /** Frame a screen or overlay opened on (its opening key must not also close it). */
  openedFrame: 0,
  focusNext: false,
  toast: null as null | { text: () => string; until: number },
  caption: null as null | { text: string; until: number },
};
export const topOverlay = (): Overlay | null => app.overlays[app.overlays.length - 1] ?? null;

// ------------------------------------------------------------------ the game's state
export interface VsPar { state: "posting" | "notPosted" | "rank" | "posted"; rank?: number | null }
export type Machine = "boot" | "title" | "mode-select" | "preparing" | "countdown" | "active" | "paused" | "resolving" | "results";
export const G = {
  machine: "boot" as Machine,
  mode: null as Mode | null,
  session: null as Sess | null,
  aim: { angle: 0, power: 50 },
  learn: null as null | { tutorialId: string; step: number; stepText: string },
  lastResults: null as null | { r: SessionResult; headline: string; total: number; parTotal: number; unlocked: string[] },
  vsPar: null as VsPar | null,
  countdownTimer: 0,
  opponentTimer: 0,
};
function transition(to: Machine): void { G.machine = to; }

const now = (): number => frame().time;
export function announce(msg: string, assertive = false): void {
  if (msg) ui.announce(msg.slice(0, 500), { politeness: assertive ? "assertive" : "polite" });
}
/** The toast (top centre, 2.6 s); `text` re-runs each frame so it follows a language change. */
export function toast(text: () => string): void {
  app.toast = { text, until: now() + 2.6 };
  announce(text());
}
audio.onCaption((text) => { if (settings.captions) app.caption = { text, until: now() + 2.4 }; });

// ------------------------------------------------------------------ fixed-step timers
let steps = 0;
let timerSeq = 0;
const timers = new Map<number, { at: number; fn: () => void }>();
function setTimer(fn: () => void, ms: number): number {
  const id = ++timerSeq;
  timers.set(id, { at: steps + Math.max(1, Math.round((ms * STEP_HZ) / 1000)), fn });
  return id;
}
function clearTimer(id: number): void { timers.delete(id); }
function runTimers(): void {
  for (const [id, t] of [...timers]) {
    if (t.at > steps) continue;
    timers.delete(id);
    t.fn();
  }
}

// ------------------------------------------------------------------ screens and overlays
function opened(): void {
  app.openedFrame = frame().frame;
  app.focusNext = true;
}
export function showScreen(name: ScreenName): void {
  app.screen = name;
  opened();
}
export function openOverlay(o: Overlay): void {
  if (topOverlay() === o) return;
  app.overlays.push(o);
  opened();
}
export function closeOverlay(o: Overlay): void {
  app.overlays = app.overlays.filter((x) => x !== o);
  opened();
}
/** Esc / B on an overlay: pause resumes, settings and help close, results need a choice. */
export function closeTop(): void {
  const top = topOverlay();
  if (top === "pause") resume();
  else if (top === "settings" || top === "help") closeOverlay(top);
}

// ------------------------------------------------------------------ identity
/** The seat this client plays: 'you' solo, the room participant id hosted. */
export function localPlayerId(): string { return G.mode === "hosted" ? rooms.myId() ?? "you" : "you"; }
export function isOpponent(id: string): boolean { return id !== localPlayerId(); }
export function playerLabel(id: string): string {
  if (!isOpponent(id)) return T("You");
  return G.mode === "hosted" ? rooms.nameOf(id) : T("AI");
}
// i18n: Learn | Journey | Daily Challenge | Practice | Challenge | Hosted match
export function modeLabel(): string {
  const m: Record<string, string> = { learn: "Learn", journey: "Journey", daily: "Daily Challenge", practice: "Practice", challenge: "Challenge", hosted: "Hosted match" };
  return G.mode && m[G.mode] ? T(m[G.mode]!) : String(G.mode ?? "");
}
export function currentCourse(): Course { return G.session!.holes[G.session!.holeIndex]!; }

/** The status bar's objective line. */
export function objectiveText(): string {
  const sess = G.session;
  if (!sess) return "Pocket Greens";
  const st = sess.state;
  const me = st.players[st.currentPlayer]!;
  if (G.learn) {
    const tut = Content.TUTORIALS.find((x) => x.id === G.learn!.tutorialId)!;
    return T(tut.title) + " — " + T(G.learn.stepText);
  }
  return st.terminal && !playback ? T("Round complete")
    : playback ? T("Ball rolling…")
    : st.phase === "aim" ? (isOpponent(me.id) ? T("Opponent is aiming…") : T("Aim and strike"))
    : T("Ball rolling…");
}
export function canAim(): boolean {
  const sess = G.session;
  if (!sess || G.machine !== "active") return false;
  const st = sess.state;
  return st.phase === "aim" && !st.terminal && !isOpponent(st.players[st.currentPlayer]!.id);
}
export function canUndo(): boolean { return canAim() && G.session!.mode === "practice" && G.session!.undone.length > 0; }

// ------------------------------------------------------------------ rounds
export function startRound(mode: Mode, holes: Course[], opts: { players?: string[]; seed?: string; challenge?: Challenge | null } = {}): void {
  transition("preparing");
  G.mode = mode;
  if (mode !== "learn") G.learn = null;
  clearTimer(G.countdownTimer);
  clearTimer(G.opponentTimer);
  playback = null;
  app.overlays = [];
  G.lastResults = null;
  G.vsPar = null;
  const players = opts.players ?? ["you"];
  G.session = Session.newSession({
    id: "local-" + steps.toString(36),
    seed: opts.seed ?? mode + "-" + holes[0]!.id,
    holes, players, mode, challenge: opts.challenge ?? null,
  });
  const theme = Content.getTheme(holes[0]!.theme);
  render.loadCourse(holes[0]!, theme);
  render.applySnapshot(G.session.state);
  render.setAim(null);
  audio.setAmbience(theme.ambience);
  transition("countdown");
  showScreen("game");
  const tut = holes[0]!.tutorial ? Content.TUTORIALS.find((x) => x.id === holes[0]!.tutorial) : undefined;
  const label = modeLabel();
  toast(() => (tut ? T("Lesson: {title}", { title: T(tut.title) }) : T("{mode} — hole {n}", { mode: label, n: 1 })));
  G.countdownTimer = setTimer(() => {
    // a pause taken during the countdown must survive it
    if (!G.session || G.machine !== "countdown") return;
    transition("active");
    afterTurn();
  }, preferences().reducedMotion ? 100 : 900);
}

function defaultAim(): void {
  const st = G.session!.state;
  const me = st.players[st.currentPlayer]!;
  const c = currentCourse();
  G.aim.angle = Math.atan2(c.cup.y - me.ball.y, c.cup.x - me.ball.x);
  G.aim.power = Math.min(70, Math.max(20, Math.hypot(c.cup.x - me.ball.x, c.cup.y - me.ball.y) * 8));
  updateAimView();
}
export function updateAimView(): void {
  const st = G.session?.state;
  if (!st || st.phase !== "aim" || !canAim() && G.machine !== "paused") { render.setAim(null); return; }
  const me = st.players[st.currentPlayer]!;
  render.setAim(me.ball, G.aim.angle, G.aim.power);
}
export function setPower(v: number): void {
  G.aim.power = Math.max(1, Math.min(100, v));
  updateAimView();
}

export function strike(): void {
  const sess = G.session;
  if (!sess || sess.state.phase !== "aim" || !canAim()) return;
  const me = sess.state.players[sess.state.currentPlayer]!;
  submitStrike({ type: "strike", angle: G.aim.angle, power: G.aim.power, by: me.id });
}
function submitStrike(cmd: Command): void {
  if (G.mode === "hosted") {
    transition("resolving");
    render.setAim(null);
    rooms.submit(cmd);
    return;
  }
  transition("resolving");
  render.setAim(null);
  handleResult(Session.applyCommand(G.session!, cmd));
}

/** A stroke's outcome (local, or adopted from the host): animate, then settle. */
export function handleResult(res: { events: GameEvent[]; error: string | null; trace?: TracePoint[] }): void {
  const sess = G.session;
  if (!sess) return;
  if (res.error) {
    audio.event({ type: "invalid", reason: res.error });
    announce(T("Invalid action: {reason}", { reason: audio.reasonText(res.error) }), true);
    transition("active");
    updateAimView();
    return;
  }
  // only the strike is acknowledged now; bounce and splash fire at their trace positions
  for (const e of res.events) if (e.type === "strike") audio.event(e);
  playTrace(res.trace ?? [], res.events, () => {
    render.applySnapshot(sess.state);
    let completed = false;
    for (const e of res.events) {
      if (e.type === "holed" || e.type === "capped" || e.type === "round-complete") audio.event(e);
      if (e.type === "hole-summary") announce(holeSummaryText(e), false);
      if (e.type === "next-hole") onNextHole(sess.holes[sess.holeIndex]!);
      if (e.type === "session-complete") completed = true;
    }
    checkLearn(res.events);
    if (completed || sess.state.terminal) { finishRound(); return; }
    if (G.machine !== "paused") transition("active");
    afterTurn();
  });
}
function holeSummaryText(e: GameEvent): string {
  const parts = Object.keys(e.totals ?? {}).map((id) => playerLabel(id) + " " + (e.totals![id]!.strokes + e.totals![id]!.penalties));
  return T("Hole finished. {scores}.", { scores: parts.join(", ") });
}
function onNextHole(course: Course): void {
  const theme = Content.getTheme(course.theme);
  render.loadCourse(course, theme);
  audio.setAmbience(theme.ambience);
  const n = G.session!.holeIndex + 1;
  toast(() => T("Hole {n} — par {par}", { n, par: course.par }));
}

export function afterTurn(): void {
  const sess = G.session;
  if (!sess || G.machine === "paused") return;
  const st = sess.state;
  if (st.terminal) { finishRound(); return; }
  const me = st.players[st.currentPlayer]!;
  if (isOpponent(me.id)) {
    render.setAim(null);
    render.applySnapshot(st);
    // hosted: the opponent's stroke arrives from the host; practice: the AI takes it after a beat
    if (G.mode === "hosted") return;
    clearTimer(G.opponentTimer);
    G.opponentTimer = setTimer(() => {
      if (!G.session || G.session !== sess || G.machine === "paused") return;
      const cur = sess.state.players[sess.state.currentPlayer];
      if (!cur || !isOpponent(cur.id) || sess.state.phase !== "aim") return;
      const cmd = Session.aiStrike(sess, cur.id);
      if (!cmd) return;
      transition("resolving");
      handleResult(Session.applyCommand(sess, cmd));
    }, preferences().reducedMotion ? 150 : 800);
    return;
  }
  render.applySnapshot(st);
  defaultAim();
}

// ------------------------------------------------------------------ trace playback (fixed steps)
interface Playback { trace: TracePoint[]; i: number; clock: number; speed: number; events: GameEvent[]; fireAt: number[]; done: () => void }
let playback: Playback | null = null;
export const replaying = (): boolean => !!playback;
function playTrace(trace: TracePoint[], events: GameEvent[], done: () => void): void {
  if (!trace.length) { done(); return; }
  // Playback never exceeds ~3.5 s of screen time: long rolls fast-forward (render.js playTrace).
  const totalMs = trace.length * Rules.DT * 1000;
  const auto = Math.max(1, totalMs / 3500);
  const speed = (preferences().reducedMotion ? 6 : 1) * auto;
  // Bounces fire where the trace passes their contact point (the browser build fired them all
  // at once near the start); a splash on the last ticks, as before.
  const fireAt: number[] = [];
  let from = 0;
  for (const e of events) {
    if (e.type === "splash") { fireAt.push(Math.max(0, trace.length - 3)); continue; }
    if (e.type !== "bounce") { fireAt.push(-1); continue; }
    let best = from, bd = Infinity;
    for (let j = from; j < trace.length; j++) {
      const d = Math.hypot(trace[j]!.x - e.x!, trace[j]!.y - e.y!);
      if (d < bd) { bd = d; best = j; }
      if (d < 1e-6) break;
    }
    fireAt.push(best);
    from = best;
  }
  playback = { trace, i: 0, clock: 0, speed, events, fireAt, done };
  placePlayback(playback, 0);
}
function placePlayback(p: Playback, alpha: number): void {
  const st = G.session?.state;
  if (!st) return;
  const a = p.trace[p.i]!, b = p.trace[Math.min(p.i + 1, p.trace.length - 1)]!;
  render.placeRolling(st, a.x + (b.x - a.x) * alpha, a.y + (b.y - a.y) * alpha, a.t);
}
function fireDue(p: Playback, all: boolean): void {
  p.events.forEach((e, k) => {
    const at = p.fireAt[k]!;
    if (at < 0 || e._fired || (!all && at > p.i)) return;
    e._fired = true;
    audio.event(e);
    if (e.type === "splash") render.spawnBurst(e.x!, e.y!, 22, 0x9fd4ff, 1.6, 2.2);
    else render.spawnBurst(e.x!, e.y!, 5, 0xffffff, 0.5, 0.8);
  });
}
function stepPlayback(): void {
  const p = playback;
  if (!p || G.machine === "paused") return;
  p.clock += (1000 / STEP_HZ) * p.speed;
  const tickMs = Rules.DT * 1000;
  while (p.i < p.trace.length - 1 && p.clock >= tickMs) { p.clock -= tickMs; p.i++; }
  const alpha = Math.min(1, p.clock / tickMs);
  placePlayback(p, alpha);
  fireDue(p, false);
  if (p.i >= p.trace.length - 1) finishPlayback();
}
/** Fast-forward: settle into the trace's exact end state now. */
export function skipTrace(): void { if (playback) finishPlayback(); }
function finishPlayback(): void {
  const p = playback;
  if (!p) return;
  p.i = p.trace.length - 1;
  placePlayback(p, 0);
  fireDue(p, true);
  playback = null;
  p.done();
}

// ------------------------------------------------------------------ results and progression
function finishRound(): void {
  const sess = G.session;
  if (!sess || G.machine === "results") return; // one results card per round
  transition("results");
  audio.event({ type: "session-complete" });
  clearTimer(G.opponentTimer);
  // hosted rounds end inside the host's state: build the envelope from its terminal block
  if (!sess.result && sess.state.terminal) {
    sess.result = {
      reason: sess.state.terminal.reason,
      results: sess.state.terminal.results.map((x) => ({ holes: 1, ...x })),
      challenge: sess.challenge ? { id: sess.challenge.id, status: sess.challengeStatus || "passed" } : null,
      perHole: sess.holes.map((h) => ({ id: h.id, par: h.par })),
    };
  }
  if (!sess.result || !sess.result.results.length) { toast(() => T("Round ended unexpectedly")); leave(); return; }
  const unlocked = awardProgress(sess);
  const r = sess.result;
  const mine = r.results.find((x) => x.id === localPlayerId()) ?? r.results[0]!;
  const parTotal = sess.holes.reduce((a, h) => a + h.par, 0);
  // i18n: Challenge passed | Challenge not met | Under or at par — nicely played | Round complete
  const headline = G.mode === "challenge" && r.challenge
    ? (r.challenge.status === "passed" ? "Challenge passed" : "Challenge not met")
    : (mine.total <= parTotal ? "Under or at par — nicely played" : "Round complete");
  G.lastResults = { r, headline, total: mine.total, parTotal, unlocked };
  render.setAim(null);
  openOverlay("results");
  announce(T("{headline}. Total {total}.", { headline: T(headline), total: mine.total }), true);
  postVsPar(mine.holes ?? 0, mine.total - parTotal);
}
/** Signed in, every finished solo round (not Learn or hosted tables) posts strokes vs par. */
function postVsPar(holes: number, vsPar: number): void {
  G.vsPar = null;
  if (!platform.signedIn() || G.mode === "learn" || G.mode === "hosted" || !(holes > 0)) return;
  const lb: VsPar = { state: "posting" };
  G.vsPar = lb;
  void platform.postVsPar(vsPar).then((r) => {
    lb.state = !r.posted ? "notPosted" : r.rank ? "rank" : "posted";
    lb.rank = r.rank;
  });
}
function awardProgress(sess: Sess): string[] {
  const p = platform.progress();
  const mine = sess.result!.results.find((r) => r.id === localPlayerId()) ?? sess.result!.results[0]!;
  const holedAny = sess.state.players.some((r) => !isOpponent(r.id) && r.holed);
  let lessonId: string | null = null;
  if (G.mode === "learn" && G.learn && holedAny) {
    lessonId = G.learn.tutorialId;
    platform.setSetting("lessons", { ...settings.lessons, [lessonId]: true });
  }
  const unlocked = ProgressDoc.record(p, {
    mode: G.mode, mine, holedAny, holes: sess.holes,
    journeyIndex: G.mode === "journey" ? Content.JOURNEY.indexOf(sess.holes[0]!) : -1, journeyLength: Content.JOURNEY.length,
    lessonId, lessonsDone: Content.TUTORIALS.filter((t) => settings.lessons[t.id]).length, lessonCount: Content.TUTORIALS.length,
    nowMs: platform.nowMs(),
  });
  platform.persist();
  platform.flush();
  return unlocked;
}
export function nextAction(): { label: string | null; run: (() => void) | null } {
  if (G.mode === "journey" && G.session) {
    const idx = Content.JOURNEY.indexOf(G.session.holes[0]!);
    if (idx >= 0 && idx + 1 < Content.JOURNEY.length) return { label: T("Next stage"), run: () => openSetup("journey", idx + 1) };
  }
  if (G.mode === "learn" && G.learn) {
    const ti = Content.TUTORIALS.findIndex((t) => t.id === G.learn!.tutorialId);
    const next = Content.TUTORIALS[ti + 1];
    if (next) return { label: T("Next lesson"), run: () => startLearn(next.id) };
  }
  return { label: null, run: null };
}
export function resultsNext(): void { const n = nextAction(); closeOverlay("results"); if (n.run) n.run(); }
export function resultsRetry(): void {
  if (!G.session) return;
  closeOverlay("results");
  if (G.mode === "hosted") { leave(); return; }
  const s = G.session;
  startRound(G.mode!, s.holes, { players: s.state.players.map((p) => p.id), challenge: s.challenge, seed: s.seed });
}

// ------------------------------------------------------------------ learn
export function startLearn(tutorialId: string): void {
  const hole = Content.AUTHORED.find((c) => c.tutorial === tutorialId) ?? Content.AUTHORED[0]!;
  const tut = Content.TUTORIALS.find((t) => t.id === tutorialId)!;
  G.learn = { tutorialId, step: 0, stepText: tut.steps[0]!.text };
  startRound("learn", [hole], { seed: "learn-" + tutorialId });
  announce(T(tut.title) + ". " + T(tut.steps[0]!.text), false);
}
function checkLearn(events: GameEvent[]): void {
  if (!G.learn) return;
  const tut = Content.TUTORIALS.find((t) => t.id === G.learn!.tutorialId)!;
  const stepDef = tut.steps[G.learn.step];
  if (!stepDef) return;
  const hit = events.some((e) => (stepDef.require === "strike" && e.type === "strike") || (stepDef.require === "holed" && e.type === "holed"));
  if (hit && G.learn.step + 1 < tut.steps.length) {
    G.learn.step += 1;
    const text = tut.steps[G.learn.step]!.text;
    G.learn.stepText = text;
    toast(() => T(text));
  }
}
export function startLearnNext(): void {
  const next = Content.TUTORIALS.find((t) => !settings.lessons[t.id]) ?? Content.TUTORIALS[0]!;
  startLearn(next.id);
}

// ------------------------------------------------------------------ setup
export const setup = { mode: "journey" as "journey" | "daily" | "practice" | "challenge", index: 0, ai: false };
export function openSetup(mode: typeof setup.mode, preset?: number): void {
  transition("mode-select");
  setup.mode = mode;
  if (mode === "journey") {
    const unlocked = platform.progress().journey.unlocked;
    setup.index = preset ?? Math.min(unlocked - 1, Content.JOURNEY.length - 1);
  } else { setup.index = 0; setup.ai = false; }
  if (G.session) { G.session = null; G.learn = null; }
  app.overlays = [];
  showScreen("setup");
}
export function utcNowMs(): number { return platform.nowMs(); }
export function setupStart(): void {
  const { mode, index } = setup;
  if (mode === "journey") startRound("journey", [Content.JOURNEY[index]!], {});
  else if (mode === "daily") startRound("daily", [Content.dailyCourse(utcNowMs())], { seed: Content.dailySeed(utcNowMs()) });
  else if (mode === "practice") startRound("practice", [Content.AUTHORED[index]!], { players: setup.ai ? ["you", "ai"] : ["you"] });
  else startRound("challenge", [Content.CHALLENGES[index]!.course], { challenge: Content.CHALLENGES[index]! });
}
export function setupBack(): void { transition("title"); showTitle(); }

// ------------------------------------------------------------------ pause / resume / leave
export function pause(): void {
  if (!G.session || G.machine === "results" || app.overlays.length) return;
  transition("paused");
  openOverlay("pause");
}
export function resume(): void {
  closeOverlay("pause");
  ui.setFocus(null);
  if (playback) { transition("resolving"); return; }
  transition("active");
  afterTurn();
}
export function restartHole(): void {
  if (!G.session) return;
  closeOverlay("pause");
  if (G.mode === "hosted") { toast(() => T("Hosted matches cannot be restarted")); resume(); return; }
  const s = G.session;
  startRound(G.mode!, [currentCourse()], { players: s.state.players.map((p) => p.id), seed: s.seed, challenge: s.challenge });
}
export function leave(): void {
  app.overlays = [];
  if (G.mode === "hosted") rooms.leave();
  clearTimer(G.countdownTimer);
  clearTimer(G.opponentTimer);
  playback = null;
  G.session = null;
  G.learn = null;
  G.mode = null;
  G.lastResults = null;
  G.vsPar = null;
  render.setAim(null);
  showTitle();
}
export function showTitle(): void {
  transition("title");
  app.overlays = [];
  G.session = null;
  render.setAim(null);
  // the title menu sits over a live garden hole (decorative; no session, no input)
  const course = Content.AUTHORED[8] ?? Content.AUTHORED[0]!;
  const theme = Content.getTheme(course.theme);
  render.loadCourse(course, theme);
  render.applySnapshot(null);
  audio.setAmbience(null);
  showScreen("title");
}

// ------------------------------------------------------------------ undo, hint, camera
export function doUndo(): void {
  const sess = G.session;
  if (!sess || sess.mode !== "practice") { toast(() => T("Undo is only available in Practice")); return; }
  if (!canAim()) return;
  if (Session.undo(sess)) {
    audio.event({ type: "undo" });
    render.applySnapshot(sess.state);
    defaultAim();
  } else toast(() => T("Nothing to undo"));
}
export function doHint(): void {
  const sess = G.session;
  if (!sess || !canAim()) return;
  if (!Rules.legalActions(sess.state).length) { toast(() => T("No actions available right now")); return; }
  const c = currentCourse();
  const me = sess.state.players[sess.state.currentPlayer]!;
  G.aim.angle = Math.atan2(c.cup.y - me.ball.y, c.cup.x - me.ball.x);
  G.aim.power = Math.min(80, Math.max(25, Math.hypot(c.cup.x - me.ball.x, c.cup.y - me.ball.y) * 9));
  updateAimView();
  announce(T("Hint: aim {deg} degrees at {power} percent power.", { deg: Math.round((G.aim.angle * 180) / Math.PI), power: Math.round(G.aim.power) }), false);
}

// ------------------------------------------------------------------ the pull-back drag
let drag: null | { x: number; y: number; moved: boolean } = null;
/** The course view's pointer (logical px from the view's top-left; null when none this frame). */
export function coursePointer(x: number, y: number, down: boolean, fresh: boolean, viewW: number, viewH: number): void {
  if (down && !drag) {
    if (!fresh || !canAim()) return;
    drag = { x, y, moved: false };
    audio.event({ type: "ui" });
    return;
  }
  if (!drag) return;
  if (!canAim()) { drag = null; return; }
  if (down) {
    const px = x - drag.x, py = y - drag.y;
    const dist = Math.hypot(px, py);
    if (dist < 12 && !drag.moved) return;
    drag.moved = true;
    // slingshot: pull back to aim the opposite way; the distance sets the power
    const d = render.courseDelta(px, py);
    const angle = Math.atan2(-d.y, -d.x);
    const power = Math.max(1, Math.min(100, (dist / Math.min(viewW, viewH)) * 160));
    if (Math.abs(angle - G.aim.angle) > 1e-4 || Math.round(power) !== Math.round(G.aim.power)) {
      G.aim.angle = angle;
      G.aim.power = power;
      updateAimView();
      audio.event({ type: "aim-tick" });
      vibrate(3);
    }
  } else {
    const was = drag.moved;
    drag = null;
    if (was) strike(); // release commits; Esc before release cancels
  }
}
export const dragging = (): boolean => !!drag;

// ------------------------------------------------------------------ actions
const shift = (): boolean => isKeyDown("ShiftLeft") || isKeyDown("ShiftRight");
const REPEAT_DELAY = 24, REPEAT_EVERY = 2;
const held: Record<string, number> = {};
const AIM: Record<string, true> = { aim_left: true, aim_right: true, power_up: true, power_down: true };
function aimAction(action: string): void {
  if (!canAim()) return;
  if (action === "aim_left") G.aim.angle -= shift() ? 0.02 : 0.09;
  else if (action === "aim_right") G.aim.angle += shift() ? 0.02 : 0.09;
  else if (action === "power_up") G.aim.power = Math.min(100, G.aim.power + (shift() ? 1 : 5));
  else if (action === "power_down") G.aim.power = Math.max(1, G.aim.power - (shift() ? 1 : 5));
  audio.event({ type: "aim-tick" });
  updateAimView();
}
/** The label of the widget that keeps arrows for the game (screens.ts sets it). */
export const keeps = { course: "", power: "" };
onAction((e) => {
  if (ui.capturingKeys()) return;
  if (e.action in AIM && !e.pressed) delete held[e.action];
  if (!e.pressed) return;
  const fresh = frame().frame !== app.openedFrame;
  const top = topOverlay();
  if (e.action === "cancel") {
    if (drag) { drag = null; defaultAim(); return; }
    if (!fresh) return;
    if (top) { closeTop(); return; }
    if (app.screen === "setup") { setupBack(); return; }
    if (app.screen === "lobby") { rooms.leaveLobby(); return; }
    if (app.screen === "game" && (G.machine === "active" || G.machine === "resolving" || G.machine === "countdown")) pause();
    return;
  }
  if (e.action === "pause") {
    if (!fresh || app.screen !== "game") return;
    if (top === "pause") { resume(); return; }
    if (!top && G.session && !G.session.finished) pause();
    return;
  }
  if (top || app.screen !== "game") return;
  if (!canAim()) {
    if (e.action === "fast_forward") skipTrace();
    return;
  }
  const f = ui.focused();
  switch (e.action) {
    case "aim_left": case "aim_right": case "power_up": case "power_down":
      if (f && f === keeps.power && (e.action === "aim_left" || e.action === "aim_right")) return; // the slider takes them
      aimAction(e.action);
      held[e.action] = 0;
      if (f && f !== keeps.course) ui.setFocus(null);
      break;
    case "strike":
      if (f && f !== keeps.course && f !== keeps.power) break; // a focused button takes its own Enter / Space / South
      strike();
      break;
    case "undo": doUndo(); break;
    case "hint": doHint(); break;
    case "camera": render.resetCamera(); break;
  }
});
function repeatHeld(): void {
  for (const a of Object.keys(held)) {
    if (!isDown(a) || !canAim() || app.overlays.length) { delete held[a]; continue; }
    const n = ++held[a]!;
    if (n >= REPEAT_DELAY && (n - REPEAT_DELAY) % REPEAT_EVERY === 0) aimAction(a);
  }
}

// ------------------------------------------------------------------ boot and lifecycle
let lookKey = "";
function applyLook(): void {
  const f = frame();
  const key = `${f.quality}:${f.levelIndex}`;
  if (key === lookKey) return;
  lookKey = key;
  render.applyLook(lookFor(f.quality, f.levelIndex));
}
function applyPrefs(): void {
  const p = preferences();
  applyContrast(p.highContrast);
  render.setHighContrast(p.highContrast || settings.palette !== "default");
  render.setReducedMotion(p.reducedMotion);
}
export function settingsChanged(): void { applyPrefs(); }

onStart(() => {
  setFixedRate(STEP_HZ);
  initStyles();
  platform.initPlatform();
  applyPrefs();
  audio.init();
  applyLook();
  showTitle();
});
onPreferencesChange(() => applyPrefs());
platform.onProgressMerged(() => undefined);
onSessionEnded(() => { toast(() => T("Signed out of StarHermit — progress keeps saving on this device.")); });
onSuspend(() => {
  // backgrounding pauses solo play; hosted play runs on
  if (G.session && G.mode !== "hosted" && G.machine === "active") pause();
  audio.setHidden(true);
  platform.flush();
});
onResume(() => audio.setHidden(false));
onQuit(() => platform.flush());

onFixedUpdate(() => {
  steps++;
  runTimers();
  stepPlayback();
  repeatHeld();
});
let frameDt = 0;
onUpdate((dt) => {
  frameDt = dt;
  applyLook();
  audio.update();
  rooms.update();
  const t = now();
  if (app.toast && app.toast.until <= t) app.toast = null;
  if (app.caption && app.caption.until <= t) app.caption = null;
});
onRender(() => {
  drawScreens();
  render.update(frameDt, frame().time * 1000, G.machine === "paused");
});
