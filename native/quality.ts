// The look per graphics level: the browser build's four presets and budgets
// (gfx.js TABLE / BUDGETS, each tuned to hold 60 FPS on the weakest GPU its
// Auto gave it) keyed by the runtime's quality tier (frame().quality), with
// the burst sparks and pollen motes scaled within the tier by the level
// (frame().levelIndex), as the browser build scaled them by its hardware
// level (at most 2×). The runtime owns the rest of the old Graphics panel:
// Auto and the level choice, render scale and the pixel-ratio cap, adaptive
// resolution, the frame-rate limit and readout, and the shadow-map size and
// MSAA samples it holds to the level. The panel's per-category overrides
// are not offered (Options choose a level).
import type { QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export type Preset = QualityTier;
export interface Budget {
  /** Course shading: Lambert (Low), standard, or standard with clear-coated physical balls (High, Ultra). */
  material: "lambert" | "standard" | "physical";
  /** Procedural textures (mowing stripes 256 px, noise / wood grain 128 px) × size. */
  texScale: number;
  /** Flower and grass-tuft density around the course. */
  foliage: number;
  /** Hedge bush icosahedron detail. */
  hedge: number;
  /** Particle pool at Particles high (low: ≤ 64). */
  sparks: number;
  /** Drifting pollen motes (Particles high). */
  pollen: number;
  bloomRes: number;
  aoRes: number;
}
export interface Look {
  preset: Preset;
  shadows: 0 | 1024 | 2048 | 4096;
  ao: "off" | "on" | "high";
  bloom: boolean;
  grade: boolean;
  antialias: AntialiasMode;
  reflections: boolean;
  /** Water shimmer and ripple drift. */
  waterAnimated: boolean;
  particles: "low" | "high";
  /** Mowing stripes, wood grain, planter crowns, cup liner, waving flag, the garden around the course, fog. */
  detailed: boolean;
  budget: Budget;
  particleBudget: number;
}

const TABLE: Record<Preset, Omit<Look, "preset" | "budget" | "particleBudget">> = {
  low: { shadows: 0, ao: "off", bloom: false, grade: false, antialias: "msaa", reflections: false, waterAnimated: false, particles: "low", detailed: false },
  balanced: { shadows: 1024, ao: "off", bloom: true, grade: true, antialias: "fxaa", reflections: true, waterAnimated: true, particles: "high", detailed: true },
  high: { shadows: 2048, ao: "on", bloom: true, grade: true, antialias: "smaa", reflections: true, waterAnimated: true, particles: "high", detailed: true },
  ultra: { shadows: 4096, ao: "high", bloom: true, grade: true, antialias: "msaa", reflections: true, waterAnimated: true, particles: "high", detailed: true },
};
const BUDGETS: Record<Preset, Budget> = {
  low: { material: "lambert", texScale: 0.5, foliage: 0.4, hedge: 1, sparks: 256, pollen: 20, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: "standard", texScale: 1, foliage: 0.6, hedge: 1, sparks: 512, pollen: 30, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: "physical", texScale: 1, foliage: 1, hedge: 2, sparks: 1024, pollen: 40, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: "physical", texScale: 2, foliage: 1.5, hedge: 2, sparks: 1536, pollen: 80, bloomRes: 1, aoRes: 1 },
};
export const SPARK_MAX = 3072;
export const POLLEN_MAX = 160;
/** The first level index of each tier (quantum, molecular, terrestrial, galactic). */
const TIER_FLOOR: Record<Preset, number> = { low: 0, balanced: 2, high: 4, ultra: 7 };

/** The look for a quality tier at a level index (0 … 9). */
export function lookFor(preset: Preset, levelIndex: number): Look {
  const b = { ...BUDGETS[preset] };
  // Levels are about 1.64× apart in GPU throughput: effect counts grow with
  // the level above the tier's first, at most 2× (gfx.js budgetFor).
  const k = Math.min(2, Math.pow(1.64, Math.max(0, levelIndex - TIER_FLOOR[preset])));
  b.sparks = Math.min(SPARK_MAX, Math.round(b.sparks * k));
  b.pollen = Math.min(POLLEN_MAX, Math.round(b.pollen * k));
  const t = TABLE[preset];
  return { preset, ...t, budget: b, particleBudget: t.particles === "high" ? b.sparks : Math.min(64, b.sparks) };
}
