// Sound, as the browser build's audio.js played it: the authored Opus clips
// of sfx/manifest.json, one per game event (strike soft or hard by power,
// bounce by material, splash, holed, capped, round and session complete,
// undo, invalid, UI click, aim tick), and the theme's quiet ambience bed
// (a low sine with a slow swell: birds/wind/meadow 147 Hz, crickets 110 Hz,
// still 196 Hz; the pond's swell faster), rendered once by OfflineAudioContext
// into a looping clip.
//
// The browser build's four buses become the runtime's (Options › Audio owns
// volumes and mute): effects at the old effects volume (0.9), UI clicks and
// aim ticks on "interface", the ambience on "music" at the old ambience
// volume (0.5) — the runtime has no ambience bus. The synthesized
// fallbacks the browser build played while a clip loaded are not ported: a
// clip not loaded yet is silent. Every clip loads at start; the bed waits
// for the mixer (in a browser, the first press). Each event
// also yields its caption text (the game's "Captions for sounds" option).
import { OfflineAudioContext, context, createClip, loadClip, play as playClip, type AudioClip, type Sound } from "starhermit:audio";
import type { GameEvent } from "./classic.ts";
import { T } from "./i18n.ts";

const EFFECTS = 0.9;
const AMBIENCE = 0.5;
const NAMES = [
  "ui-click", "aim-tick", "invalid-buzz", "strike-soft", "strike-hard", "bounce-wall", "bounce-mover", "bounce-turf",
  "splash", "holed", "capped", "round-complete", "session-complete", "undo",
];
const clips = new Map<string, AudioClip>();

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
    catch { /* the mixer is full this frame: skip it */ }
  }
  const cap = captionFor(e);
  if (cap && captionSink) captionSink(cap);
}

/** Loads every clip at once (onStart); a cue whose clip is still loading is silent. */
export function init(): void {
  for (const name of NAMES) {
    loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); }, (e: unknown) => { console.warn(`sfx ${name}: ${String(e)}`); });
  }
}

// ---- ambience
const beds = new Map<string, AudioClip>();
let ambience: Sound | null = null;
let ambienceKind: string | null = null;
let ambienceWanted: string | null = null;
let hidden = false;
const bedsAsked = new Set<string>();
/** The browser build's oscillator bed: a whole number of swells and carrier cycles, so it loops seamlessly. */
async function renderBed(kind: string): Promise<AudioClip> {
  const rate = 22050;
  const lfoHz = kind === "water" ? 0.4 : 0.18;
  const len = Math.round(rate * (kind === "water" ? 5 : 50 / 9));
  const secs = len / rate;
  const base = kind === "crickets" ? 110 : kind === "still" ? 196 : 147;
  const off = new OfflineAudioContext(1, len, rate);
  const carrier = off.createOscillator(); carrier.frequency.value = Math.round(base * secs) / secs;
  const swell = off.createOscillator(); swell.frequency.value = Math.round(lfoHz * secs) / secs;
  const depth = off.createGain(); depth.gain.value = 0.025;
  const g = off.createGain(); g.gain.value = 0.05;
  swell.connect(depth).connect(g.gain);
  carrier.connect(g).connect(off.destination);
  carrier.start(); swell.start();
  return createClip(await off.startRendering());
}
/** The theme's ambience (null: none). */
export function setAmbience(kind: string | null): void { ambienceWanted = kind; }
/** The window is hidden: the bed stops until it shows again. */
export function setHidden(h: boolean): void { hidden = h; }

/** Each frame: once the mixer runs, keep the bed going. */
export function update(): void {
  if (context.state !== "running") return;
  const want = hidden ? null : ambienceWanted;
  if (want === ambienceKind && (ambience || !want)) return;
  const bed = want ? beds.get(want) : undefined;
  if (want && !bed) {
    if (!bedsAsked.has(want)) {
      bedsAsked.add(want);
      renderBed(want).then((c) => { beds.set(want, c); }, (e: unknown) => console.warn(`ambience: ${String(e)}`));
    }
    return;
  }
  try {
    if (ambience) { ambience.stop(); ambience = null; }
    ambienceKind = want;
    if (bed) ambience = playClip(bed, { bus: "music", gain: AMBIENCE, loop: true });
  } catch (e) { console.warn(`ambience: ${String(e)}`); ambience = null; }
}
