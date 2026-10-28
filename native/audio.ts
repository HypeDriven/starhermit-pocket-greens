// Sound, as the browser build's audio.js played it: the authored Opus clips
// of sfx/manifest.json, one per game event (strike soft or hard by power,
// bounce by material, splash, holed, capped, round and session complete,
// undo, invalid, UI click, aim tick), and the theme's quiet ambience bed
// (a low sine with a slow swell: birds/wind/meadow 147 Hz, crickets 110 Hz,
// still 196 Hz; the pond's swell faster), now rendered once into a looping
// clip instead of a live oscillator graph (a live synthesis graph makes clip
// loads fail on the engine's web runtime).
//
// The browser build's four buses become the runtime's (Options › Audio owns
// volumes and mute): effects at the old effects volume (0.9), UI clicks and
// aim ticks on "interface", the ambience on "music" at the old ambience
// volume (0.5) — the runtime has no ambience bus. The synthesized
// fallbacks the browser build played while a clip loaded are not ported: a
// clip not loaded yet is silent. Clips load once the mixer runs (natively
// at once, in a browser after the first press), one at a time. Each event
// also yields its caption text (the game's "Captions for sounds" option).
import { context, createClip, loadClip, play as playClip, type AudioClip, type Sound } from "starhermit:audio";
import type { GameEvent } from "./classic.ts";
import { T } from "./i18n.ts";

const EFFECTS = 0.9;
const AMBIENCE = 0.5;
const NAMES = [
  "ui-click", "aim-tick", "invalid-buzz", "strike-soft", "strike-hard", "bounce-wall", "bounce-mover", "bounce-turf",
  "splash", "holed", "capped", "round-complete", "session-complete", "undo",
];
const clips = new Map<string, AudioClip>();
const queue: string[] = [];
let loading = false;
let wanted = false;

function clipFor(e: GameEvent): string | null {
  switch (e.type) {
    case "ui": return "ui-click";
    case "aim-tick": return "aim-tick";
    case "invalid": return "invalid-buzz";
    case "strike": return e.power != null && e.power >= 66 ? "strike-hard" : "strike-soft";
    case "bounce": return e.material === "wall" ? "bounce-wall" : e.material === "mover" ? "bounce-mover" : "bounce-turf";
    case "splash": case "holed": case "capped": case "round-complete": case "session-complete": case "undo": return e.type;
    default: return null;
  }
}
function captionFor(e: GameEvent): string {
  switch (e.type) {
    case "invalid": return T("Invalid action: {reason}", { reason: e.reason ? reasonText(e.reason) : "" });
    case "strike": return e.power != null ? T("Stroke {n}% power", { n: Math.round(e.power) }) : T("Stroke");
    case "splash": return T("Splash — penalty stroke");
    case "holed": return T("Holed in {n} (par {par})", { n: e.strokes || "?", par: e.par || "?" });
    case "capped": return T("Stroke cap reached");
    case "round-complete": return T("Round complete");
    case "session-complete": return T("Session results ready");
    case "undo": return T("Undone");
    default: return "";
  }
}
/** A rules rejection code as player-facing text. */
export function reasonText(code: string): string {
  const k = "reason." + code;
  const t = T(k);
  return t !== k ? t : String(code || "");
}

let captionSink: ((text: string) => void) | null = null;
export function onCaption(fn: (text: string) => void): void { captionSink = fn; }

/** Plays the event's clip (once loaded) and captions it. */
export function event(e: GameEvent): void {
  const name = clipFor(e);
  const clip = name ? clips.get(name) : undefined;
  if (clip) {
    const ui = e.type === "ui" || e.type === "aim-tick";
    try { playClip(clip, { bus: ui ? "interface" : "effects", gain: EFFECTS }); }
    catch { clips.delete(name!); load(name!); }
  }
  const cap = captionFor(e);
  if (cap && captionSink) captionSink(cap);
}

function load(name: string): void { if (!queue.includes(name) && !clips.has(name)) queue.push(name); }
function pump(): void {
  if (loading || !queue.length) return;
  const name = queue.shift()!;
  loading = true;
  loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); loading = false; }, (e: unknown) => { console.warn(`sfx ${name}: ${String(e)}`); loading = false; });
}
export function init(): void { wanted = true; }

// ---- ambience
const beds = new Map<string, AudioClip>();
let ambience: Sound | null = null;
let ambienceKind: string | null = null;
let ambienceWanted: string | null = null;
let hidden = false;
/** The browser build's oscillator bed as samples: a whole number of swells and carrier cycles, so it loops seamlessly. */
function bedClip(kind: string): AudioClip {
  let c = beds.get(kind);
  if (c) return c;
  const rate = 22050;
  const lfoHz = kind === "water" ? 0.4 : 0.18;
  const len = Math.round(rate * (kind === "water" ? 5 : 50 / 9));
  const secs = len / rate;
  const base = kind === "crickets" ? 110 : kind === "still" ? 196 : 147;
  const f = Math.round(base * secs) / secs, lf = Math.round(lfoHz * secs) / secs;
  const data = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const t = i / rate;
    data[i] = Math.sin(2 * Math.PI * f * t) * (0.05 + 0.025 * Math.sin(2 * Math.PI * lf * t));
  }
  c = createClip([data], rate);
  beds.set(kind, c);
  return c;
}
/** The theme's ambience (null: none). */
export function setAmbience(kind: string | null): void { ambienceWanted = kind; }
/** The window is hidden: the bed stops until it shows again. */
export function setHidden(h: boolean): void { hidden = h; }

/** Each frame: queue the clips once the mixer runs (one load at a time), keep the bed going. */
export function update(): void {
  if (context.state !== "running") return;
  if (wanted) {
    wanted = false;
    for (const n of NAMES) load(n);
  }
  pump();
  const want = hidden ? null : ambienceWanted;
  if (want === ambienceKind && (ambience || !want)) return;
  try {
    if (ambience) { ambience.stop(); ambience = null; }
    ambienceKind = want;
    if (want) ambience = playClip(bedClip(want), { bus: "music", gain: AMBIENCE, loop: true });
  } catch (e) { console.warn(`ambience: ${String(e)}`); ambience = null; }
}
