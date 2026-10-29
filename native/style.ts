// The look of the menus and HUD: the browser build's style sheet, rewritten
// class-based in tools/ui-style.css and converted once with `starhermit css`
// into assets/ui-style.json (`npm run css`), registered at start with the
// theme the runtime's own widgets (checkboxes, selects, sliders, scroll
// bars) fall back to. The browser build's body.high-contrast palette is a
// token set here, applied while the runtime's high-contrast option is on.
import { files } from "starhermit:engine";
import * as ui from "starhermit:ui";

type Tokens = Record<string, string | number>;
let base: Tokens = {};
const HIGH_CONTRAST: Tokens = {
  bg: "#000000", panel: "#111111", "panel-2": "#1c1c1c", ink: "#ffffff", "ink-dim": "#dddddd", accent: "#ffff00", "accent-2": "#00ffff",
  "panel-a": "rgba(17, 17, 17, 0.88)", "bg-a92": "rgba(0, 0, 0, 0.92)", "bg-a68": "rgba(0, 0, 0, 0.92)",
};
export const COLORS = { bg: "#1c2a1e", panel: "#24382a", panel2: "#2d4534", ink: "#f0f4ec", dim: "#b9c8b4", accent: "#7ec96e", accent2: "#f2c14e", danger: "#e06a5a", focus: "#ffd54e" };
export const COLORS_HC = { bg: "#000000", panel: "#111111", panel2: "#1c1c1c", ink: "#ffffff", dim: "#dddddd", accent: "#ffff00", accent2: "#00ffff", danger: "#e06a5a", focus: "#ffd54e" };

export function initStyles(): void {
  const css = files.readJson("assets/ui-style.json") as unknown as ui.CssStyles;
  base = { ...(css.tokens as Tokens) };
  ui.setTheme({
    fontSize: 16, smallSize: 14, headingSize: 24, padding: 8, spacing: 8, radius: 10,
    text: COLORS.ink, muted: COLORS.dim, panel: COLORS.panel, control: COLORS.panel2, hovered: "#365340",
    pressed: "#3d5c47", field: COLORS.panel, accent: COLORS.accent, focus: COLORS.focus, outline: "#3d5c47",
  });
  ui.setTokens(css.tokens);
  ui.setAnimations(css.animations);
  ui.setStyles({
    ...css.styles,
    label: { text: { color: "$ink" } },
    paragraph: { text: { color: "$ink" } },
    checkbox: {
      text: { color: "$ink" }, minHeight: 44,
      parts: { box: { background: "$panel-2", border: { width: 1, color: "#4a6a52" }, radius: 4 }, mark: { background: "$accent" } },
    },
    select: { text: { color: "$ink" }, background: "$panel-2", border: { width: 1, color: "#4a6a52" }, radius: 8, minHeight: 44 },
    slider: { minHeight: 36, parts: { track: { background: "#6f8a74", radius: 3 }, fill: { background: "$accent", radius: 3 }, thumb: { background: "$accent", radius: 10 } } },
    scrollArea: { parts: { bar: { background: "#4a6a52", radius: 4 } } },
  });
}

let hcKey: boolean | null = null;
/** The high-contrast tokens over the sheet's while the runtime's option is on. */
export function applyContrast(highContrast: boolean): void {
  if (hcKey === highContrast) return;
  hcKey = highContrast;
  ui.setTokens(highContrast ? { ...base, ...HIGH_CONTRAST } : base);
}
