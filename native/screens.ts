// The browser build's DOM shell (index.html + ui.js) as starhermit:ui, built
// every frame over the course view: the title card over a live garden hole
// (menu with its subtitles, progress, the account line, sign-in / invite,
// Hosted Play when signed in), the mode setup card (Journey stage select,
// Daily, Practice holes with the optional AI, Challenges), the hosted lobby,
// and the game screen — the status bar (objective, hole, par, strokes,
// total, cloud-save status, Pause), the Progress and Status rails over the
// course, the stroke tray (power slider, Strike, Undo, Hint), sound
// captions and the toast — with the Pause, Settings, Help and Results
// cards. The old media queries are layouts picked by the window's logical
// size: phone (≤ 700 px wide: the rails at the top, each under half the
// width and at most 38 % of the course's height, scrolling; the tray
// wrapping across the bottom) and short landscape (≤ 500 px tall: a
// slimmer status bar, rails up to 60 %). The course view takes the
// pull-back drag; the rails and tray take the pointer above it.
import { clipboard, frame, openMenu } from "starhermit:engine";
import { bindings, primaryPointer } from "starhermit:input";
import * as draw from "starhermit:draw";
import * as ui from "starhermit:ui";
import { requestSignIn } from "starhermit:platform";
import * as audio from "./audio.ts";
import { Content, ProgressDoc } from "./classic.ts";
import { T } from "./i18n.ts";
import {
  G, app, canAim, canUndo, closeOverlay, coursePointer, currentCourse, doHint, doUndo, isOpponent, keeps, leave, localPlayerId,
  modeLabel, nextAction, objectiveText, openOverlay, openSetup, pause, playerLabel, replaying, restartHole, resultsNext,
  resultsRetry, resume, setPower, settings, settingsChanged, setup, setupBack, setupStart, startLearnNext, strike, toast, topOverlay, utcNowMs,
} from "./main.ts";
import * as platform from "./platform.ts";
import * as render from "./render.ts";
import * as rooms from "./rooms.ts";
import { COLORS, COLORS_HC } from "./style.ts";

// ------------------------------------------------------------------ layout
interface Layout { lw: number; lh: number; sc: number; ox: number; oy: number; phone: boolean; shortLand: boolean; mid: boolean }
function layoutNow(): Layout {
  const f = frame();
  const sc = ui.preferences().scale;
  const sa = f.safeArea;
  const lw = Math.max(1, (f.width - sa.left - sa.right) / sc), lh = Math.max(1, (f.height - sa.top - sa.bottom) / sc);
  return { lw, lh, sc, ox: sa.left, oy: sa.top, phone: lw <= 700, shortLand: lw > lh && lh <= 500, mid: lw <= 1023 };
}
const colors = (): typeof COLORS => (ui.preferences().highContrast ? COLORS_HC : COLORS);
const lastHeight = new Map<string, number>();
const remember = (key: string, r: { height: number }, sc: number): void => { lastHeight.set(key, r.height / sc); };
function textWidth(text: string, style: string | readonly string[], kind?: "button"): number {
  return ui.measureText(text, { ...(kind ? { kind } : {}), style: typeof style === "string" ? [style] : [...style] }).width / ui.preferences().scale;
}
/** Text up to `width` wide: one label when it fits, else a wrapped paragraph. */
function para(text: string, width: number, cls: string | readonly string[] = "body", id?: string): void {
  if (!text) return;
  const styles = typeof cls === "string" ? [cls] : [...cls];
  let u = ui.style(...styles);
  if (id) u = u.id(id);
  if (textWidth(text, styles) <= width) u.label(text);
  else u.paragraph(text, width);
}
interface Btn { id: string; text: string; style?: string[]; disabled?: boolean; selected?: boolean; act: () => void; sub?: string; silent?: boolean }
function buttonWidth(b: Btn): number {
  const style = b.style ?? ["btn"];
  if (b.sub) return Math.max(textWidth(b.text, faceStyle(style)), textWidth(b.sub, "btn-sub")) + 40;
  return textWidth(b.text, style, "button") + 4;
}
function faceStyle(style: readonly string[]): string[] { return [style.includes("btn-primary") ? "btn-label-primary" : "btn-label"]; }
/** A button `width` wide (null: its text's); a label too long for it wraps; `sub` adds the old <small> line. */
function button(b: Btn, width: number | null = null): boolean {
  const style = b.style ?? ["btn"];
  const opts: ui.ButtonOptions = {};
  if (b.disabled) opts.disabled = true;
  if (b.selected !== undefined) opts.selected = b.selected;
  const s: ui.Style = width != null ? { width } : {};
  const inner = (width ?? buttonWidth(b)) - 36;
  if (b.sub) {
    const primary = style.includes("btn-primary");
    opts.content = () => {
      ui.column(`${b.id}-face`, () => {
        para(b.text, inner, faceStyle(style));
        para(b.sub!, inner, primary ? "btn-sub-primary" : "btn-sub");
      }, { spacing: 0, width: inner });
    };
  } else if (width != null && buttonWidth(b) > width) {
    opts.content = () => { ui.style(...faceStyle(style), { text: { align: "center" } }).paragraph(b.text, inner); };
  }
  if (ui.style(...style, s).id(b.id).button(b.sub ? `${b.text}. ${b.sub}` : b.text, opts)) {
    if (!b.silent) audio.event({ type: "ui" });
    b.act();
    return true;
  }
  return false;
}
/** Buttons at their own widths in rows wrapping at `width` (CSS flex-wrap), each row centred or not. */
function flow(label: string, list: Btn[], width: number, gap = 8, center = false): void {
  const rows: Btn[][] = [[]];
  let used = 0;
  for (const b of list) {
    const bw = Math.min(width, buttonWidth(b));
    if (rows[rows.length - 1]!.length && used + gap + bw > width) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? gap : 0) + bw;
    rows[rows.length - 1]!.push(b);
  }
  ui.column(label, () => {
    rows.forEach((row, ri) => ui.row(`${label}-r${ri}`, () => {
      for (const b of row) button(b, buttonWidth(b) > width ? width : null);
    }, { spacing: gap, align: "center", ...(center ? { justify: "center" as const, width } : {}) }));
  }, { spacing: gap, width });
}
const keysFor = (action: string): string => {
  const named: Record<string, string> = { ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", Escape: "Esc" };
  return bindings(action).filter((b) => b.device === "keyboard").map((b) => named[b.code ?? ""] ?? b.label).join(" / ") || "—";
};
const padFor = (action: string): string => bindings(action).filter((b) => b.device === "gamepad").map((b) => b.label)[0] ?? "—";

// ------------------------------------------------------------------ the frame
function firstFocus(): string | null {
  const top = topOverlay();
  if (top === "pause") return "p-resume";
  if (top === "results") return nextAction().label ? "r-next" : "r-retry";
  if (top === "settings") return "set-captions";
  if (top === "help") return "help-close";
  if (app.screen === "title") return "m-play";
  if (app.screen === "setup") return "setup-start";
  if (app.screen === "lobby") return "lobby-back";
  return null;
}
export function drawScreens(): void {
  const L = layoutNow();
  if (app.focusNext && frame().frame - app.openedFrame >= 2) {
    const first = firstFocus();
    if (first && primaryPointer() !== "coarse") ui.setFocus(first);
    app.focusNext = false;
  }
  const f = frame();
  if (app.screen === "game" && G.session) gameScreen(L);
  else {
    render.setView({ x: 0, y: 0, w: f.width, h: f.height }, f.width, f.height);
    if (app.screen === "setup") setupScreen(L);
    else if (app.screen === "lobby") lobbyScreen(L);
    else titleScreen(L);
  }
  const top = topOverlay();
  if (top === "pause") pauseCard(L);
  else if (top === "settings") settingsCard(L);
  else if (top === "help") helpCard(L);
  else if (top === "results") resultsCard(L);
  captions(L);
  toastView(L);
}

// ------------------------------------------------------------------ cards on a dimmed screen
/** A screen: a card up to `maxW` wide centred on the dim, its body scrolling when taller than the window; `footer` stays below. */
function screenCard(key: string, L: Layout, dim: string, maxW: number, body: (w: number) => void, footer?: (w: number) => void): void {
  const padOut = L.phone || L.shortLand ? 12 : 16;
  const cw = Math.max(220, Math.min(maxW, L.lw - padOut * 2));
  const padIn = L.phone ? 16 : 24;
  const inner = cw - padIn * 2;
  const fH = footer ? (lastHeight.get(`${key}:f`) ?? 50) + 12 : 0;
  const room = Math.max(80, L.lh - padOut * 2 - padIn * 2 - fH);
  const bh = lastHeight.get(`${key}:b`) ?? 0;
  ui.place(`scr-${key}`, { anchor: "top-start", x: 0, y: 0 }, () => {
    ui.column(`${key}-card`, () => {
      const inside = (w: number): void => { remember(`${key}:b`, ui.column(`${key}-body`, () => body(w), { width: w, spacing: 10 }), L.sc); };
      if (bh > room + 1) ui.scrollArea(`${key}-scroll`, { width: inner, height: room }, () => inside(inner - 14), { padding: { end: 12 } });
      else inside(inner);
      if (footer) remember(`${key}:f`, ui.column(`${key}-foot`, () => footer(inner), { width: inner, spacing: 8 }), L.sc);
    }, { style: "card", width: cw, spacing: 12 });
  }, { style: dim, width: L.lw, height: L.lh, align: "center", justify: "center", padding: padOut });
}

// ------------------------------------------------------------------ title
function titleScreen(L: Layout): void {
  const p = platform.progress();
  screenCard("title", L, "screen-title", 544, (w) => {
    ui.style("h1").id("title-h").heading("Pocket Greens");
    para(T("A whimsical garden of miniature courses. Aim, set power, and hole out in the fewest strokes."), w, "body", "tagline");
    const items: Btn[] = [
      { id: "m-play", text: T("Play — continue Journey"), sub: T("Reach the green in two actions"), style: ["btn", "btn-primary", "btn-menu"], act: () => openSetup("journey") },
      { id: "m-learn", text: T("Learn"), sub: T("Interactive lessons, one rule at a time"), style: ["btn", "btn-menu"], act: startLearnNext },
      { id: "m-journey", text: T("Journey"), sub: T("44 authored and seeded stages"), style: ["btn", "btn-menu"], act: () => openSetup("journey") },
      { id: "m-daily", text: T("Daily Challenge"), sub: T("One shared course per UTC day"), style: ["btn", "btn-menu"], act: () => openSetup("daily") },
      { id: "m-practice", text: T("Practice"), sub: T("Any hole, undo allowed, unranked"), style: ["btn", "btn-menu"], act: () => openSetup("practice") },
      { id: "m-challenge", text: T("Challenges"), sub: T("Constrained goals for mastery"), style: ["btn", "btn-menu"], act: () => openSetup("challenge") },
      { id: "m-settings", text: T("Settings"), style: ["btn", "btn-menu"], act: () => openOverlay("settings") },
    ];
    if (rooms.available()) items.push({ id: "m-hosted", text: T("Hosted Play"), sub: T("Private match against a friend or AI"), style: ["btn", "btn-menu"], act: rooms.openLobby });
    if (L.shortLand && w >= 420) {
      const cw = (w - 8) / 2;
      for (let i = 0; i < items.length; i += 2) ui.row(`menu-${i}`, () => { for (const b of items.slice(i, i + 2)) button(b, cw); }, { spacing: 8 });
    } else ui.column("menu", () => { for (const b of items) button(b, w); }, { spacing: 8, width: w });
    const done = Object.keys(p.journey.stars).length;
    para(T("Journey: {done}/{total} stages • Holes completed: {holes}", { done, total: Content.JOURNEY.length, holes: p.mastery.holesCompleted }) +
      (p.mastery.bestDaily ? " • " + T("Best daily: {n}", { n: p.mastery.bestDaily }) : ""), w, "body", "title-progress");
    if (platform.signedIn()) para(T("Playing as {name} — progress syncs to your account", { name: platform.displayName() || "…" }), w, "muted", "title-account");
    const acct: Btn[] = [];
    if (!platform.signedIn()) acct.push({ id: "m-signin", text: T("Sign in with StarHermit"), act: () => { void requestSignIn().catch(() => undefined); } });
    const link = platform.inviteLink();
    if (link) {
      acct.push({
        id: "m-invite", text: T("Invite a friend"),
        act: () => {
          try { clipboard.writeText(link); toast(() => T("Invite link copied to the clipboard.")); }
          catch { toast(() => T("Copy this invite link: {link}", { link })); }
        },
      });
    }
    if (acct.length) flow("account", acct, w);
  });
}

// ------------------------------------------------------------------ setup
function bullet(text: string, w: number, id: string, cls = "body"): void {
  ui.row(`${id}-li`, () => { ui.style("body").label("•"); para(text, w - 22, cls, id); }, { spacing: 8, align: "start" });
}
function setupScreen(L: Layout): void {
  const p = platform.progress();
  const mode = setup.mode;
  const titles = { journey: T("Journey"), daily: T("Daily Challenge"), practice: T("Practice"), challenge: T("Challenges") };
  screenCard("setup", L, "screen", 544, (w) => {
    ui.style("h2").id("setup-h").heading(titles[mode]);
    let desc = "", duration = "", players = "1", assists = "", extra = "";
    if (mode === "journey") {
      desc = T("44 stages that introduce one concept at a time, then combine them. Mastery stages every chapter.");
      duration = T("~2 minutes per stage"); assists = T("Hints available");
      extra = T("Unlocked: {n} / {total}", { n: p.journey.unlocked, total: Content.JOURNEY.length });
    } else if (mode === "daily") {
      desc = T("One shared seed and ruleset per UTC day. Everyone plays the same green.");
      duration = T("~2 minutes");
      assists = platform.signedIn() ? T("No undo • best recorded to your account") : T("No undo");
      extra = T("Seed: {seed} (local clock)", { seed: Content.dailySeed(utcNowMs()) }) + (platform.signedIn() ? " • " + T("Platform boards are read-only") : "");
    } else if (mode === "practice") {
      desc = T("Any hole, restart and undo freely, deterministic AI opponent optional. Never affects rating.");
      duration = T("As long as you like"); players = T("1 (AI optional)"); assists = T("Undo + hints");
    } else {
      desc = T("Constrained goals: move limits, speed targets, restricted power.");
      duration = T("~1 minute each"); assists = T("None");
    }
    para(desc, w, "body", "setup-desc");
    ui.column("setup-facts", () => {
      bullet(T("Duration: {v}", { v: duration }), w, "fact-duration");
      bullet(T("Players: {v}", { v: players }), w, "fact-players");
      bullet(T("Assists: {v}", { v: assists }), w, "fact-assists");
      bullet(T("Unranked — does not affect rating"), w, "fact-ranked");
      if (extra) bullet(extra, w, "fact-extra");
    }, { spacing: 4, width: w });
    if (mode === "journey") {
      const unlocked = p.journey.unlocked;
      const options = Content.JOURNEY.map((c, i) => {
        const locked = i >= unlocked;
        const best = p.journey.stars[c.id];
        return { text: `${i + 1}. ${T("par {par}", { par: c.par })}${best ? " ★" + best : ""}${locked ? " — " + T("locked") : ""}`, disabled: locked };
      });
      ui.row("stage-row", () => {
        ui.style("body").label(T("Stage"));
        ui.spacer();
        const next = ui.style({ width: Math.min(260, w - 100) }).id("setup-stage").select(T("Stages"), setup.index, options);
        if (next !== setup.index && !options[next]!.disabled) { setup.index = next; toast(() => T("Stage {n} selected", { n: next + 1 })); }
      }, { style: "setting-row", width: w, align: "center", spacing: 10 });
    } else if (mode === "practice") {
      const ai = ui.id("setup-ai").checkbox(T("AI opponent"), setup.ai);
      if (ai !== setup.ai) { setup.ai = ai; audio.event({ type: "ui" }); }
      grid("practice-holes", Content.AUTHORED.map((c, i) => ({
        id: `hole-${c.id}`, text: `${c.id} ${T("par {par}", { par: c.par })}`, style: ["btn-grid"], selected: setup.index === i, act: () => { setup.index = i; },
      })), w, 136);
    } else if (mode === "challenge") {
      grid("challenges", Content.CHALLENGES.map((ch, i) => ({
        id: `ch-${ch.id}`, text: T(ch.name), sub: T(ch.desc), style: ["btn-grid"], selected: setup.index === i, act: () => { setup.index = i; },
      })), w, 200);
    }
  }, (w) => {
    flow("setup-actions", [
      { id: "setup-start", text: T("Start"), style: ["btn", "btn-primary"], act: setupStart },
      { id: "setup-back", text: T("Back"), act: setupBack },
    ], w);
  });
}
/** CSS grid auto-fill minmax(min, 1fr): equal columns, buttons stretched. */
function grid(label: string, list: Btn[], w: number, min: number): void {
  const cols = Math.max(1, Math.floor((w + 8) / (min + 8)));
  const cw = (w - 8 * (cols - 1)) / cols;
  ui.column(label, () => {
    for (let i = 0; i < list.length; i += cols) {
      ui.row(`${label}-${i}`, () => { for (const b of list.slice(i, i + cols)) button(b, cw); }, { spacing: 8, align: "stretch" });
    }
  }, { spacing: 8, width: w });
}

// ------------------------------------------------------------------ hosted lobby
function lobbyScreen(L: Layout): void {
  const h = rooms.state();
  screenCard("lobby", L, "screen", 544, (w) => {
    ui.style("h2").id("lobby-h").heading(T("Hosted Match"));
    if (!h) return;
    if (h.room) para(T("Room {id}", { id: h.room.id }), w, "muted", "lobby-room");
    for (const pp of h.participants.slice(0, 2)) bullet(pp.displayName + (pp.id === h.myPid ? " " + T("(you)") : ""), w, `lobby-p-${pp.id}`);
    para(h.status, w, "body", "lobby-status");
    const list: Btn[] = [];
    if (h.isHost && h.participants.length >= 2 && !h.started) list.push({ id: "lobby-start", text: T("Start match"), style: ["btn", "btn-primary"], act: rooms.hostStart });
    list.push({ id: "lobby-practice", text: T("Practice vs AI"), style: h.failed ? ["btn", "btn-primary"] : ["btn"], act: rooms.practiceInstead });
    flow("lobby-actions", list, w);
  }, (w) => { button({ id: "lobby-back", text: T("Leave lobby"), act: rooms.leaveLobby }, Math.min(w, 220)); });
}

// ------------------------------------------------------------------ the game screen
let courseWasDown = false;
// i18n: Cloud save: synced | Cloud save: saving… | Cloud save: offline — will retry | Cloud save: error — will retry
function syncLabel(): string {
  if (!platform.signedIn()) return "";
  const s = platform.syncState();
  return T(({ synced: "Cloud save: synced", saving: "Cloud save: saving…", offline: "Cloud save: offline — will retry", error: "Cloud save: error — will retry" } as const)[s]);
}
function gameScreen(L: Layout): void {
  const sess = G.session!;
  const st = sess.state;
  const course = currentCourse();
  const me = st.players[st.currentPlayer]!;
  const mine = st.players.find((x) => x.id === localPlayerId()) ?? me;
  const tot = sess.totals[mine.id] ?? { strokes: 0, penalties: 0, holes: 0 };
  const f = frame();
  const c = colors();
  const topH = lastHeight.get("statusbar") ?? 44;
  const pf = { x: 0, y: topH, w: L.lw, h: Math.max(40, L.lh - topH) };
  const view = { x: L.ox + pf.x * L.sc, y: L.oy + pf.y * L.sc, w: pf.w * L.sc, h: pf.h * L.sc };
  render.setView(view, f.width, f.height);
  // the page colour in the safe-area strips around the window's content
  if (L.ox || L.oy || f.safeArea.right || f.safeArea.bottom) {
    ui.place("safe-bg", { anchor: "top-start", x: 0, y: 0 }, () => {
      ui.widget("", { role: "none", size: { width: 0, height: 0 }, draw: () => {
        draw.rect(0, 0, f.width, view.y, c.bg);
        draw.rect(0, view.y + view.h, f.width, f.height - view.y - view.h, c.bg);
      } });
    }, { width: 0, height: 0 });
  }

  // ---- the course: the pull-back drag (built first: rails and tray above it take the pointer)
  const courseLabel = T("Miniature golf course view");
  keeps.course = courseLabel;
  ui.place("course-host", { anchor: "top-start", x: pf.x, y: pf.y }, () => {
    const res = ui.widget(courseLabel, { role: "region", size: { width: pf.w, height: pf.h }, description: objectiveText() });
    const p = res.pointer;
    const down = !!p && (p.buttons & 1) !== 0;
    const fresh = down && !courseWasDown && !!p && p.inside && !topOverlay();
    courseWasDown = down;
    if (p) coursePointer(p.x / L.sc, p.y / L.sc, down, fresh, pf.w, pf.h);
    else coursePointer(0, 0, false, false, pf.w, pf.h);
  });

  // ---- status bar
  const stats: [string, string][] = [
    [T("Hole"), `${sess.holeIndex + 1}/${sess.holes.length}`], [T("Par"), String(course.par)],
    [T("Strokes"), `${me.strokes}${me.penalties ? ` (+${me.penalties})` : ""}`], [T("Total"), String(tot.strokes + tot.penalties)],
  ];
  const statItem = ([k, v]: [string, string], i: number): void => {
    ui.row(`stat-${i}`, () => { ui.style("stat").label(k); ui.style("stat-b").id(`stat-v-${i}`).label(v); }, { spacing: 4, align: "center" });
  };
  const pauseBtn = (): void => { button({ id: "btn-pause", text: T("⏸ Pause"), disabled: !G.session || G.machine === "results", act: pause }); };
  const sync = syncLabel();
  const objective = objectiveText();
  const sbR = ui.place("statusbar", { anchor: "top-start", x: 0, y: 0 }, () => {
    const one = textWidth(objective, "objective") + stats.reduce((a, s) => a + textWidth(s[0] + " " + s[1], "stat-b") + 20, 0) + (sync ? textWidth(sync, "stat") + 16 : 0) + 140;
    if (one <= L.lw - 24) {
      ui.row("sb-1", () => {
        ui.style("objective").id("objective").label(objective);
        stats.forEach(statItem);
        if (sync) ui.style("stat").id("sync").label(sync);
        ui.spacer();
        pauseBtn();
      }, { spacing: 16, align: "center", width: L.lw - 24 });
    } else {
      ui.row("sb-1", () => {
        para(objective, Math.max(80, L.lw - 24 - textWidth(stats[0]![0] + " " + stats[0]![1], "stat-b") - textWidth(stats[1]![0] + " " + stats[1]![1], "stat-b") - 40), "objective", "objective");
        statItem(stats[0]!, 0); statItem(stats[1]!, 1);
      }, { spacing: 12, align: "center", width: L.lw - 24 });
      ui.row("sb-2", () => {
        statItem(stats[2]!, 2); statItem(stats[3]!, 3);
        if (sync && L.lw > 420) ui.style("stat").id("sync").label(sync);
        ui.spacer();
        pauseBtn();
      }, { spacing: 12, align: "center", width: L.lw - 24 });
    }
  }, { style: "statusbar", width: L.lw, spacing: 4, padding: { top: L.shortLand ? 4 : 6, bottom: L.shortLand ? 4 : 6, start: 12, end: 12 } });
  remember("statusbar", sbR, L.sc);

  // ---- rails
  const railW = L.phone ? Math.floor(L.lw / 2 - 10) : L.mid ? 208 : 272;
  const railMaxH = pf.h * (L.phone ? 0.38 : L.shortLand ? 0.6 : 0.8);
  const gap = L.phone ? 6 : 8;
  const myTurn = st.phase === "aim" && !isOpponent(me.id);
  rail("rail-left", L, { x: gap, y: pf.y + gap }, railW, railMaxH, "start", (w) => {
    ui.style("rail-h2").label(T("Progress").toUpperCase());
    para(modeLabel(), w, "body", "rail-mode");
    para(T("Seed: {seed}", { seed: sess.seed }), w, "body", "rail-seed");
    for (const id of Object.keys(sess.totals)) {
      const tt = sess.totals[id]!;
      para(T("{player}: <b>{n}</b> over {holes} hole(s)", { player: playerLabel(id), n: tt.strokes + tt.penalties, holes: tt.holes }), w, "body", `rail-total-${id}`);
    }
  });
  rail("rail-right", L, { x: L.lw - gap - railW, y: pf.y + gap }, railW, railMaxH, "end", (w) => {
    ui.style("rail-h2").label(T("Status").toUpperCase());
    para(myTurn && !replaying() ? T("Drag back from the ball or use arrow keys. Power {n}%.", { n: Math.round(G.aim.power) })
      : isOpponent(me.id) ? T("Opponent turn") : T("Resolving…"), w, "body", "rail-status");
    const stop = rooms.stopReason();
    if (G.mode === "hosted" && stop) {
      ui.column("online-notice", () => para(rooms.stopText(stop), w - 22, "body", "online-notice-text"), { style: "online-notice", width: w });
    }
    button({ id: "btn-help", text: T("Help"), style: ["btn", ...(L.phone ? ["btn-rail"] : [])], act: () => openOverlay("help") }, w);
    button({ id: "btn-settings", text: T("Settings"), style: ["btn", ...(L.phone ? ["btn-rail"] : [])], act: () => openOverlay("settings") }, w);
  });

  // ---- stroke tray
  const act = canAim();
  const trayW = L.phone ? L.lw - 16 : Math.min(L.lw - 16, 640);
  const sliderW = L.phone ? 104 : 144;
  const powerLabel = T("Power");
  keeps.power = powerLabel;
  const trayH = lastHeight.get("tray") ?? 52;
  const trayR = ui.place("tray", { anchor: "top-start", x: (L.lw - trayW) / 2, y: L.lh - trayH - 8 }, () => {
    const power = (): void => {
      ui.row("power-wrap", () => {
        ui.style("body").label(powerLabel);
        const v = ui.id("power").slider(powerLabel, Math.round(G.aim.power), { min: 1, max: 100, step: 1, width: sliderW });
        if (act && v !== Math.round(G.aim.power)) setPower(v);
        ui.style("bold").id("power-val").label(String(Math.round(G.aim.power)));
      }, { style: "power-wrap", spacing: 8, align: "center" });
    };
    const btns: Btn[] = [
      { id: "btn-strike", text: T("Strike"), style: ["btn", "btn-primary"], disabled: !act, act: () => { strike(); ui.setFocus(null); }, silent: true },
      { id: "btn-undo", text: T("Undo"), disabled: !canUndo(), act: () => { doUndo(); ui.setFocus(null); } },
      { id: "btn-hint", text: T("Hint"), disabled: !act, act: () => { doHint(); ui.setFocus(null); } },
    ];
    const powerW = textWidth(powerLabel, "body") + sliderW + 40 + 40;
    const all = powerW + btns.reduce((a, b) => a + buttonWidth(b) + 8, 0);
    if (all <= trayW) ui.row("tray-row", () => { power(); for (const b of btns) button(b); }, { spacing: 8, align: "center", justify: "center", width: trayW });
    else {
      ui.row("tray-row1", () => { power(); button(btns[0]!); }, { spacing: 8, align: "center", justify: "center", width: trayW });
      ui.row("tray-row2", () => { button(btns[1]!); button(btns[2]!); }, { spacing: 8, align: "center", justify: "center", width: trayW });
    }
  }, { width: trayW, spacing: 8 });
  remember("tray", trayR, L.sc);
}
/** A rail over the course: content-sized up to `maxH`, scrolling past it. */
function rail(key: string, L: Layout, at: { x: number; y: number }, w: number, maxH: number, _side: "start" | "end", body: (w: number) => void): void {
  const pad = L.phone ? 7 : 10;
  const inner = w - pad * 2;
  const bh = lastHeight.get(key) ?? 0;
  ui.place(key, { anchor: "top-start", x: at.x, y: at.y }, () => {
    const content = (ww: number): void => { remember(key, ui.column(`${key}-in`, () => body(ww), { width: ww, spacing: L.phone ? 4 : 8 }), L.sc); };
    if (bh + pad * 2 > maxH + 1) ui.scrollArea(`${key}-scroll`, { width: inner, height: Math.max(40, maxH - pad * 2) }, () => content(inner - 12));
    else content(inner);
  }, { style: "rail", width: w, padding: pad });
}

// ------------------------------------------------------------------ overlays
function overlayCard(key: string, L: Layout, title: string, body: (w: number) => void, footer: (w: number) => void): void {
  const width = Math.max(220, Math.min(480, L.lw - 32));
  const padX = L.phone || L.shortLand ? 16 : 24;
  const inner = width - padX * 2;
  const room = Math.min(L.lh * 0.9, L.lh - 32) - padX * 2;
  const fH = (lastHeight.get(`${key}:f`) ?? 56) + 8;
  const tH = (lastHeight.get(`${key}:t`) ?? 32) + 8;
  const bodyMax = Math.max(60, room - fH - tH);
  const bh = lastHeight.get(`${key}:b`) ?? 0;
  ui.style("overlay-card").dialog(key, "", true, () => {
    ui.column(`${key}-card`, () => {
      remember(`${key}:t`, ui.style("h2").id(`${key}-h`).heading(title), L.sc);
      const inside = (w: number): void => { remember(`${key}:b`, ui.column(`${key}-body`, () => body(w), { width: w, spacing: 8 }), L.sc); };
      if (bh > bodyMax + 1) ui.scrollArea(`${key}-scroll`, { width: inner, height: bodyMax }, () => inside(inner - 14), { scrollTo: frame().frame - app.openedFrame < 6 ? { top: 0 } : undefined });
      else inside(inner);
      remember(`${key}:f`, ui.column(`${key}-foot`, () => footer(inner), { width: inner, spacing: 8 }), L.sc);
    }, { width: inner, spacing: 8 });
  });
}
function pauseCard(L: Layout): void {
  overlayCard("pause", L, T("Paused"), () => undefined, (w) => {
    button({ id: "p-resume", text: T("Resume"), style: ["btn", "btn-primary"], act: resume }, w);
    button({ id: "p-settings", text: T("Settings"), act: () => openOverlay("settings") }, w);
    button({ id: "p-help", text: T("Help"), act: () => openOverlay("help") }, w);
    button({ id: "p-restart", text: T("Restart hole"), act: restartHole }, w);
    button({ id: "p-leave", text: T("Leave round"), style: ["btn", "btn-danger"], act: leave }, w);
  });
}
function settingsCard(L: Layout): void {
  overlayCard("settings", L, T("Settings"), (w) => {
    ui.style("h3").label(T("Audio"));
    const cap = ui.id("set-captions").checkbox(T("Captions for sounds"), settings.captions);
    if (cap !== settings.captions) { platform.setSetting("captions", cap); audio.event({ type: "ui" }); }
    ui.style("h3").label(T("Graphics"));
    const pals = ProgressDoc.PALETTES;
    const idx = Math.max(0, pals.indexOf(settings.palette));
    ui.row("pal-row", () => {
      para(T("Color-vision palette"), w - Math.min(200, w * 0.5) - 10, "body", "pal-label");
      ui.spacer();
      const next = ui.style({ width: Math.min(200, w * 0.5) }).id("set-palette").select(T("Color-vision palette"), idx, pals.map((p) => T("palette." + p)));
      if (next !== idx) { platform.setSetting("palette", pals[next]!); settingsChanged(); }
    }, { style: "setting-row", width: w, align: "center", spacing: 10 });
    ui.style("h3").label(T("Controls"));
    ui.row("lessons-row", () => {
      para(T("Replay tutorials"), w - 170, "body", "lessons-label");
      ui.spacer();
      button({ id: "set-reset-lessons", text: T("Reset lessons"), act: () => { platform.setSetting("lessons", {}); toast(() => T("Lessons reset")); } });
    }, { style: "setting-row", width: w, align: "center", spacing: 10 });
    para(T("Sound volumes, graphics quality, language, key bindings, text size, high contrast, reduced motion and vibration are in the StarHermit Options."), w, "muted", "options-note");
    button({ id: "set-options", text: T("Open Options"), act: () => openMenu() });
  }, (w) => { button({ id: "settings-close", text: T("Done"), style: ["btn", "btn-primary"], act: () => closeOverlay("settings") }, w); });
}
function helpCard(L: Layout): void {
  overlayCard("help", L, T("How to play"), (w) => {
    para(T("help.goal"), w, "body", "help-goal");
    ui.style("h3").label(T("Controls"));
    const k = keysFor;
    const rows: [string, string][] = [
      [T("Aim"), T("Drag from ball, or {left} / {right} rotate (hold Shift for fine)", { left: k("aim_left"), right: k("aim_right") })],
      [T("Power"), T("Drag distance, or {up} / {down} (slider)", { up: k("power_up"), down: k("power_down") })],
      [T("Strike"), T("Release drag, {key}, or Strike button", { key: k("strike") })],
      [T("Cancel aim"), T("{key} or release outside", { key: k("cancel") })],
      [T("Pause"), T("{key} or ⏸ button", { key: k("pause") })],
      [T("Undo (practice)"), k("undo")],
      [T("Hint"), k("hint")],
      [T("Camera reset"), k("camera")],
      [T("Fast-forward roll"), k("fast_forward")],
      [T("Gamepad"), T("{aim} aim and power, {strike} strike, {cancel} cancel, {hint} hint, {undo} undo, {ff} fast-forward, {pause} pause", {
        aim: [padFor("aim_left"), padFor("power_up")].join(" / "), strike: padFor("strike"), cancel: padFor("cancel"), hint: padFor("hint"), undo: padFor("undo"), ff: padFor("fast_forward"), pause: padFor("pause"),
      })],
    ];
    rows.forEach(([a, b], i) => bullet(`${a}: ${b}`, w, `help-c-${i}`));
    ui.style("h3").label(T("Hazards"));
    ["help.water", "help.sand", "help.walls", "help.keepers"].forEach((key, i) => bullet(T(key), w, `help-h-${i}`));
    para(T("Fast balls can lip out of the cup — arrive softly."), w, "body", "help-lip");
  }, (w) => { button({ id: "help-close", text: T("Close"), style: ["btn", "btn-primary"], act: () => closeOverlay("help") }, w); });
}
function resultsCard(L: Layout): void {
  const lr = G.lastResults;
  if (!lr) return;
  const r = lr.r;
  overlayCard("results", L, T("Results"), (w) => {
    para(T("{headline} — {total} vs par {par}", { headline: T(lr.headline), total: lr.total, par: lr.parTotal }), w, "bold", "res-headline");
    // columns sized to their headings and values; the player's name takes the rest
    const heads = ["#", T("Player"), T("Strokes"), T("Penalties"), T("Total")];
    const cols = heads.map((h, i) => i === 1 ? 0 : Math.max(textWidth(h, "th"), ...r.results.map((x) => textWidth(String([r.results.length, 0, x.strokes, x.penalties, x.total][i]), "td-b"))) + 14);
    cols[1] = Math.max(60, w - cols.reduce((a, b) => a + b, 0));
    const cell = (text: string, i: number, cls: string, id: string): void => {
      ui.column(`${id}-c`, () => para(text, cols[i]! - 4, cls, id), { width: cols[i]! });
    };
    ui.row("res-head", () => {
      heads.forEach((h, i) => cell(h, i, "th", `res-th-${i}`));
    }, { width: w, align: "end" });
    r.results.forEach((row, ri) => {
      ui.row(`res-row-${ri}`, () => {
        cell(String(ri + 1), 0, "td", `res-${ri}-0`);
        cell(playerLabel(row.id), 1, "td", `res-${ri}-1`);
        cell(String(row.strokes), 2, "td", `res-${ri}-2`);
        cell(String(row.penalties), 3, "td", `res-${ri}-3`);
        cell(String(row.total), 4, "td-b", `res-${ri}-4`);
      }, { width: w, align: "start" });
    });
    if (r.challenge) {
      const ch = Content.CHALLENGES.find((x) => x.id === r.challenge!.id);
      const status = r.challenge.status === "passed" ? T("passed")
        : T("not met — {reason}", { reason: T("challenge." + r.challenge.status.replace("failed:", "")) });
      para(T("Challenge {name}:", { name: ch ? T(ch.name) : r.challenge.id }) + " " + status, w, "body", "res-challenge");
    }
    if (lr.unlocked.length) para(T(lr.unlocked.length > 1 ? "New achievements:" : "New achievement:") + " " + lr.unlocked.map((n) => T(n)).join(", "), w, "bold", "res-ach");
    const lb = G.vsPar;
    if (lb) {
      para(lb.state === "posting" ? T("Posting score to the leaderboard…") : lb.state === "notPosted" ? T("Score not posted to the leaderboard.")
        : lb.state === "rank" ? T("Leaderboard rank: #{rank}", { rank: lb.rank ?? "" }) : T("Score posted to the leaderboard."), w, "muted", "res-lb");
    }
  }, (w) => {
    const next = nextAction();
    if (next.label) button({ id: "r-next", text: next.label, style: ["btn", "btn-primary"], act: resultsNext }, w);
    button({ id: "r-retry", text: T("Retry"), act: resultsRetry }, w);
    button({ id: "r-menu", text: T("Main menu"), act: leave }, w);
  });
}

// ------------------------------------------------------------------ captions and toast
function chip(key: string, L: Layout, text: string, cls: string, yFromTop: number | null, yFromBottom: number | null): void {
  const maxW = Math.min(L.lw - 32, 560);
  const w = Math.min(maxW, textWidth(text, "body") + 34);
  const h = lastHeight.get(key) ?? 34;
  const y = yFromTop != null ? yFromTop : L.lh - (yFromBottom ?? 0) - h;
  ui.place(key, { anchor: "top-start", x: (L.lw - w) / 2, y }, () => {
    remember(key, ui.column(`${key}-in`, () => para(text, w - 34, "body", `${key}-text`), { style: cls, width: w }), L.sc);
  }, { width: w });
}
function captions(L: Layout): void {
  if (!app.caption) return;
  chip("captions", L, app.caption.text, "captions", null, (lastHeight.get("tray") ?? 52) + 24);
}
function toastView(L: Layout): void {
  if (!app.toast) return;
  chip("toast", L, app.toast.text(), "toast", (lastHeight.get("statusbar") ?? 44) + 12, null);
}
