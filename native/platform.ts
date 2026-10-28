// The game's data and the StarHermit platform, on the runtime's modules:
// - progress (journey unlocks and best strokes, achievements, mastery
//   counters) is the browser build's checksummed document (js/progress.js),
//   the game's save (starhermit:storage `saves`) on the device and in the
//   player's cloud slot; two devices' copies merge (js/progress.js merge).
//   The slot the browser build wrote (the JS SDK's save.json, key
//   game:<slug>, the same document) shows as foreign and is merged in and
//   replaced once;
// - the game's own options (sound captions, the colour-vision palette, the
//   completed lessons) are `settings` (game.<key>, synced with the
//   account); the browser build's per-player settings carry them over,
//   then all its keys are removed. Volumes, mute, graphics, language,
//   reduced motion, high contrast, text size and vibration are the
//   runtime's Options;
// - the player, the invite link, the platform's clock (the daily's date)
//   and posting a finished solo round's strokes against par through
//   score-script.js (a practice session whose socket carries { type:
//   'result', scores: { 'vs-par': n } }, as the JS SDK's submitScores did)
//   with the rank on the `vs-par` board.
import type { JsonValue } from "starhermit:engine";
import {
  connectGame, inviteLink as fetchInviteLink, leaderboards, onPlayerChange, player, serverNow, serverTime, sessions,
  type Leaderboard,
} from "starhermit:platform";
import { saves, settings as store } from "starhermit:storage";
import { ProgressDoc, type Progress } from "./classic.ts";

// --- the save ------------------------------------------------------------------------
let doc: Progress = ProgressDoc.blank();
let lastSavedAt = 0;
const mergedListeners = new Set<() => void>();
export function onProgressMerged(fn: () => void): void { mergedListeners.add(fn); }
function merged(): void { for (const fn of mergedListeners) fn(); }

export function progress(): Progress { return doc; }
/** Seals the save and writes it (device at once, the account debounced). */
export function persist(): void {
  ProgressDoc.seal(doc);
  try { saves.save(doc as unknown as JsonValue, { schema: 1 }); }
  catch (e) { console.warn(`save: ${String(e)}`); }
}
function adopt(other: unknown): boolean {
  const d = ProgressDoc.parse(other);
  if (!d) return false;
  const next = ProgressDoc.merge(d, doc);
  if (ProgressDoc.same(next, doc)) return false;
  doc = next;
  persist();
  return true;
}

saves.onConflict((local, remote) => ({
  merged: ProgressDoc.merge(ProgressDoc.parse(remote.data), ProgressDoc.parse(local?.data)) as unknown as JsonValue,
}));
saves.onStatus((_status, state) => {
  if (state === "foreign") { migrateForeign(); return; }
  const cur = saves.load();
  if (cur && cur.savedAt !== lastSavedAt) {
    lastSavedAt = cur.savedAt;
    if (adopt(cur.data)) merged();
  }
});

/** The browser build's cloud save: merged with this device's progress and saved over it once. */
function migrateForeign(): void {
  const old = saves.foreign();
  if (!old) return;
  let parsed: unknown = null;
  try { parsed = old.text ? JSON.parse(old.text) : null; } catch { parsed = null; }
  const remote = ProgressDoc.parse(parsed);
  const changed = !!remote && !ProgressDoc.same(ProgressDoc.merge(remote, doc), doc);
  if (remote) doc = ProgressDoc.merge(remote, doc);
  ProgressDoc.seal(doc);
  try { saves.save(doc as unknown as JsonValue, { schema: 1, replaceForeign: true }); }
  catch (e) { console.warn(`save migration: ${String(e)}`); }
  if (changed) merged();
}

/** The account line: offline (a guest) | saving | synced | error. */
export function syncState(): "offline" | "saving" | "synced" | "error" {
  if (!player()) return "offline";
  const st = saves.state();
  if (st === "error" || st === "read-blocked") return "error";
  if (st === "loading" || st === "uploading" || st === "foreign" || saves.status() === "pending") return "saving";
  return "synced";
}
export function flush(): void { void saves.flush().catch(() => undefined); }

// --- the game's options ---------------------------------------------------------------
export interface Settings { captions: boolean; palette: string; lessons: Record<string, boolean> }
export const settings: Settings = { captions: false, palette: "default", lessons: {} };
type Key = keyof Settings;
function readSetting(key: Key): void {
  let v: JsonValue | undefined;
  try { v = store.get(key); } catch { return; }
  const ok = ProgressDoc.checkSetting(key, v);
  if (ok !== undefined) (settings as unknown as Record<string, unknown>)[key] = ok;
}
function adoptSetting(key: Key, value: unknown): void {
  const v = ProgressDoc.checkSetting(key, value);
  if (v === undefined) return;
  try {
    if (store.get(key) !== undefined) return;
    store.set(key, v as JsonValue);
    (settings as unknown as Record<string, unknown>)[key] = v;
  } catch { /* keep the device's */ }
}
export function setSetting<K extends Key>(key: K, value: Settings[K]): void {
  settings[key] = value;
  try { store.set(key, value as unknown as JsonValue); } catch (e) { console.warn(`setting ${key}: ${String(e)}`); }
}
function importLegacy(): void {
  const keys = store.legacyKeys();
  if (!keys) return;
  const old: Record<string, unknown> = {};
  for (const key of keys) if (ProgressDoc.LEGACY_KEYS.includes(key)) old[key] = store.legacy(key);
  for (const [k, v] of Object.entries(ProgressDoc.gameSettingsFrom(old))) adoptSetting(k as Key, v);
  for (const key of keys) if (ProgressDoc.LEGACY_KEYS.includes(key)) store.removeLegacy(key);
}

export function initPlatform(): void {
  const cur = saves.load();
  lastSavedAt = cur?.savedAt ?? 0;
  doc = ProgressDoc.parse(cur?.data) ?? ProgressDoc.blank();
  for (const k of Object.keys(settings) as Key[]) readSetting(k);
  store.onChange((key) => { if (key in settings) readSetting(key as Key); });
  store.onLegacy(importLegacy);
  importLegacy();
  if (saves.state() === "foreign") migrateForeign();
  refreshPlayer();
  void serverTime().catch(() => undefined);
}

// --- the player and the clock ----------------------------------------------------------
export function signedIn(): boolean { return !!player(); }
export function displayName(): string { return player()?.displayName ?? ""; }
export function userId(): string | null { return player()?.userId ?? null; }
let invite: string | null = null;
export function inviteLink(): string | null { return player() ? invite : null; }
function refreshPlayer(): void {
  invite = null;
  board = null;
  if (!player()) return;
  fetchInviteLink().then((u) => { invite = u; }, () => { invite = null; });
}
const playerListeners = new Set<() => void>();
export function onPlayer(fn: () => void): void { playerListeners.add(fn); }
onPlayerChange(() => { refreshPlayer(); for (const fn of playerListeners) fn(); });

/** Now in ms by the platform's clock when it has answered, else the device's. */
export function nowMs(): number {
  try { return serverNow() ?? Date.now(); } catch { return Date.now(); }
}

// --- the vs-par board ------------------------------------------------------------------
const BOARD = "vs-par";
let board: Leaderboard | null = null;
async function vsParBoard(): Promise<Leaderboard | null> {
  if (board) return board;
  const list = await leaderboards.list();
  board = list.find((b) => b.key === BOARD) ?? null;
  return board;
}

/** Signed in only: posts a finished round's strokes relative to par; { posted, rank }. Never rejects. */
export async function postVsPar(vsPar: number): Promise<{ posted: boolean; rank: number | null }> {
  const me = player();
  if (!me) return { posted: false, rank: null };
  const score = Math.round(vsPar);
  let accepted: string[] = [];
  try {
    const sessionId = await sessions.practice();
    accepted = await new Promise<string[]>((resolve) => {
      const socket = connectGame(sessionId);
      let done = false;
      const finish = (list: string[]): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.close();
        resolve(list);
      };
      const timer = setTimeout(() => finish([]), 15000);
      socket.on("open", () => { socket.sendCommand({ type: "result", scores: { [BOARD]: score } }); });
      socket.on("game", (data) => {
        const d = data as { type?: string; accepted?: string[] } | null;
        if (d && d.type === "result-ack") finish(Array.isArray(d.accepted) ? d.accepted : []);
      });
      socket.on("error", () => finish([]));
      socket.on("stopped", () => finish([]));
      socket.on("abandoned", () => finish([]));
    });
  } catch { return { posted: false, rank: null }; }
  if (!accepted.includes(BOARD)) return { posted: false, rank: null };
  try {
    const b = await vsParBoard();
    if (!b) return { posted: true, rank: null };
    const r = await leaderboards.entries(b.id, { pageSize: 100 });
    const mine = r.items.find((e) => e.userId === me.userId);
    return { posted: true, rank: mine ? mine.rank : null };
  } catch { return { posted: true, rank: null }; }
}
