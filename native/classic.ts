// The browser build's pure game scripts, shared unchanged with the node tests
// and server.js: the deterministic rules and physics (js/rules.js), the
// content (js/content.js: themes, the 12 authored holes, 32 seeded stages,
// lessons, challenges, the daily), the session (js/session.js: holes,
// totals, practice undo, the replay envelope, the practice AI), the string
// tables (js/strings.js) and the progression save (js/progress.js),
// evaluated as classic scripts that register on globalThis.PG.
import { loadClassic } from "starhermit:script";

for (const f of ["js/rules.js", "js/content.js", "js/session.js", "js/strings.js", "js/progress.js"]) loadClassic(f);

export interface Zone { type: "rect" | "circle"; x: number; y: number; w?: number; h?: number; r?: number; material?: string }
export interface Mover { type: "mover"; x: number; y: number; r: number; axis: "x" | "y"; amp: number; period: number; phase: number }
export interface Course {
  id: string; contentVersion: number; w: number; h: number; par: number; cap?: number; theme: string; tutorial?: string; seed?: string;
  mechanics: string[]; start: { x: number; y: number }; cup: { x: number; y: number };
  walls: Zone[]; obstacles: Zone[]; water: Zone[]; sand: Zone[]; movers: Mover[];
}
export interface Ball { x: number; y: number; vx: number; vy: number }
export interface Player { id: string; ball: Ball; lastRest: { x: number; y: number }; strokes: number; penalties: number; invalid: number; holed: boolean }
export interface ResultRow { id: string; total: number; strokes: number; penalties: number; invalid: number; holed?: boolean; holes?: number; elapsedMs?: number }
export interface State {
  version: number; seed: string; courseId: string; par: number; cap: number; tick: number;
  phase: "aim" | "roll" | "complete"; players: Player[]; currentPlayer: number;
  holeResults: { id: string; strokes: number; penalties: number; total: number }[];
  terminal: { reason: string; results: ResultRow[] } | null;
}
export interface GameEvent {
  type: string; x?: number; y?: number; player?: string; material?: string; strokes?: number; par?: number;
  angle?: number; power?: number; cap?: number; reason?: string; hole?: number;
  totals?: Record<string, { strokes: number; penalties: number; holes: number }>;
  result?: SessionResult; _fired?: boolean;
}
export interface TracePoint { t: number; x: number; y: number }
export interface Command { type: string; angle?: number; power?: number; by?: string; id?: string }
export interface Theme { id: string; name: string; ambience: string; palette: Record<"green" | "rough" | "wall" | "water" | "sand" | "cup" | "ball" | "obstacle" | "mover" | "sky", number> }
export interface Challenge { id: string; name: string; desc: string; course: Course; maxPower?: number; strokeLimit?: number; timeLimitTicks?: number; noPenalties?: boolean; requireBounce?: boolean }
export interface Tutorial { id: string; title: string; steps: { text: string; require: string }[] }
export interface SessionResult {
  reason: string; results: ResultRow[]; challenge: { id: string; status: string } | null; perHole: { id: string; par: number }[];
}
export interface Sess {
  id: string; mode: string; seed: string; holes: Course[]; holeIndex: number; state: State;
  totals: Record<string, { strokes: number; penalties: number; holes: number }>;
  undone: string[]; commands: Command[]; finished: boolean; result: SessionResult | null;
  challenge: Challenge | null; challengeStatus: string | null;
}
export interface StepResult { state: State; events: GameEvent[]; error: string | null; trace: TracePoint[] }
export interface Progress {
  version: number; journey: { unlocked: number; stars: Record<string, number> }; achievements: Record<string, number>;
  mastery: { holesCompleted: number; noPenaltyHoles: number; bestDaily: number | null; underParStreak: number }; checksum?: number;
}

interface RulesApi {
  DT: number; BALL_R: number; CUP_R: number; MAX_POWER: number;
  makeState(seed: string, course: Course, players: string[]): State;
  invalidReason(state: State, cmd: Command): string | null;
  legalActions(state: State): unknown[];
  step(state: State, course: Course, cmd: Command): StepResult;
  moverPos(m: Mover, tick: number): { x: number; y: number; r: number };
  hashStr(s: string): number;
  mulberry32(seed: number): () => number;
}
interface ContentApi {
  THEMES: Theme[]; AUTHORED: Course[]; JOURNEY: Course[]; TUTORIALS: Tutorial[]; CHALLENGES: Challenge[];
  getTheme(id: string): Theme;
  dailySeed(date?: number): string;
  dailyCourse(date?: number): Course;
}
interface SessionModule {
  newSession(o: { id?: string; seed: string; holes: Course[]; players: string[]; mode: string; challenge?: Challenge | null }): Sess;
  applyCommand(s: Sess, cmd: Command): { events: GameEvent[]; error: string | null; trace?: TracePoint[] };
  undo(s: Sess): boolean;
  aiStrike(s: Sess, id: string): Command | null;
}
interface StringsApi { EN: Record<string, string>; STRINGS: Record<string, Record<string, string>> }
interface ProgressApi {
  ACHIEVEMENTS: { key: string; name: string; desc: string }[]; LEGACY_KEYS: string[]; GAME_SETTINGS: Record<string, unknown>; PALETTES: string[];
  blank(): Progress; seal(p: Progress): Progress; parse(j: unknown): Progress | null; merge(r: Progress | null, l: Progress | null): Progress; same(a: Progress, b: Progress): boolean;
  record(p: Progress, o: Record<string, unknown>): string[];
  checkSetting(key: string, v: unknown): unknown;
  gameSettingsFrom(old: unknown): Record<string, unknown>;
}

const PG = (globalThis as unknown as { PG: { rules: RulesApi; content: ContentApi; session: SessionModule; strings: StringsApi; progress: ProgressApi } }).PG;
export const Rules = PG.rules;
export const Content = PG.content;
export const Session = PG.session;
export const Strings = PG.strings;
export const ProgressDoc = PG.progress;
