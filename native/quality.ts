// The look per graphics level. Shadows, AO, bloom, the grade and anti-aliasing
// come from the engine's levelSettings() for the frame's level; the art columns
// here (the browser build's gfx.js TABLE / BUDGETS) stay keyed by its quality
// tier, with the burst sparks and pollen motes scaled within the tier by the
// level's particle budget (at most 2×). The runtime owns the rest of the old
// Graphics panel: Auto and the level choice, render scale and the pixel-ratio
// cap, adaptive resolution, the frame-rate limit and readout. The panel's
// per-category overrides are not offered (Options choose a level).
import { levelSettings, type GraphicsLevel, type LevelSettings, type QualityTier } from "starhermit:engine";
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
}
export interface Look {
  preset: Preset;
  /** Key-light shadow map: the level's size (0 = off). */
  shadows: number;
  ao: { resolution: number; samples: number; denoiseSamples: number } | null;
  /** The level's bloom resolution (null = off). */
  bloom: number | null;
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

type Art = Pick<Look, "reflections" | "waterAnimated" | "particles" | "detailed">;
const ART: Record<Preset, Art> = {
  low: { reflections: false, waterAnimated: false, particles: "low", detailed: false },
  balanced: { reflections: true, waterAnimated: true, particles: "high", detailed: true },
  high: { reflections: true, waterAnimated: true, particles: "high", detailed: true },
  ultra: { reflections: true, waterAnimated: true, particles: "high", detailed: true },
};
const BUDGETS: Record<Preset, Budget> = {
  low: { material: "lambert", texScale: 0.5, foliage: 0.4, hedge: 1, sparks: 256, pollen: 20 },
  balanced: { material: "standard", texScale: 1, foliage: 0.6, hedge: 1, sparks: 512, pollen: 30 },
  high: { material: "physical", texScale: 1, foliage: 1, hedge: 2, sparks: 1024, pollen: 40 },
  ultra: { material: "physical", texScale: 2, foliage: 1.5, hedge: 2, sparks: 1536, pollen: 80 },
};
export const SPARK_MAX = 3072;
export const POLLEN_MAX = 160;
/** Each tier's first level: its budgets are authored for this level's particle budget. */
const ANCHOR: Record<Preset, GraphicsLevel> = { low: "quantum", balanced: "molecular", high: "terrestrial", ultra: "galactic" };

/** The look for a level's settings. */
export function lookFor(s: LevelSettings = levelSettings()): Look {
  const preset = s.quality;
  const b = { ...BUDGETS[preset] };
  // Effect counts grow with the level's particle budget above the tier's first level, at most 2×.
  const k = Math.min(2, s.particles / levelSettings(ANCHOR[preset]).particles);
  b.sparks = Math.min(SPARK_MAX, Math.round(b.sparks * k));
  b.pollen = Math.min(POLLEN_MAX, Math.round(b.pollen * k));
  const art = ART[preset];
  return {
    preset, ...art,
    shadows: s.shadows ? s.shadowMapSize : 0,
    ao: s.ao && { resolution: s.ao.resolution, samples: s.ao.samples, denoiseSamples: s.ao.denoiseSamples },
    bloom: s.bloom ? s.bloom.resolution : null,
    grade: s.grade,
    antialias: s.antialias,
    budget: b,
    particleBudget: art.particles === "high" ? b.sparks : Math.min(64, b.sparks),
  };
}
