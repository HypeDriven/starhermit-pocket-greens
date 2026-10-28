// Hosted play (signed in): the browser build's net.js + bootstrap.js rooms
// flow on starhermit:platform rooms. Quick-join an open two-seat table of
// this game, or host one (its metadata names today's daily course and
// seed) and wait for an opponent; the host starts the match. The HOST runs
// the same deterministic rules (js/rules.js): a guest sends its strike
// commands, the host validates them (seat, turn, legality, idempotent by
// command id), steps the rules and broadcasts the new state, events and
// roll trace to everyone (over the 8 KB frame cap the trace is dropped and
// the guest settles at once). The sender of every frame is the platform's
// participant id, never a name inside the payload. Names are the
// participants' display names.
//
// Policy (results are server-authoritative): a host-routed table has no
// server script refereeing it, so hosted rounds are not recorded — no
// leaderboard post, no room result (the browser build's POST
// /rooms/{id}/result has no counterpart on the runtime).
import { rooms, type Participant, type Room, type RoomSocket } from "starhermit:platform";
import * as audio from "./audio.ts";
import { Content, Rules, type Command, type Course, type GameEvent, type State, type TracePoint } from "./classic.ts";
import { T } from "./i18n.ts";
import { G, announce, handleResult, showScreen, showTitle, startRound, toast } from "./main.ts";
import * as platform from "./platform.ts";

const MAX_FRAME = 8 * 1024 - 64;
export type Stop = null | "terms" | "expired" | "unavailable";
interface Hosted {
  room: Room | null; socket: RoomSocket | null; myPid: string | null; hostPid: string | null; isHost: boolean;
  participants: Participant[]; started: boolean; course: Course | null; players: string[];
  cmdSeq: number; applied: Record<string, true>; pending: Record<string, Command>;
  status: string; failed: boolean;
}
let H: Hosted | null = null;
let stop: Stop = null;
const enc = new TextEncoder();
const dec = new TextDecoder();

export function available(): boolean { return platform.signedIn(); }
export function state(): Readonly<Hosted> | null { return H; }
export function stopReason(): Stop { return stop; }
export function myId(): string | null { return H?.myPid ?? null; }
export function nameOf(id: string): string {
  const p = H?.participants.find((x) => x.id === id);
  return p ? p.displayName : T("Player {id}", { id: String(id).slice(0, 8) });
}
export function stopText(kind: Stop): string {
  return kind === "terms" ? T("Accept the updated StarHermit terms to keep playing online — reopen the game from StarHermit.")
    : kind === "expired" ? T("Your StarHermit session expired — reopen the game from StarHermit to play online.")
    : kind === "unavailable" ? T("This table is no longer available — leave the round to play solo or start a new match.") : "";
}

function errKind(e: unknown): string { return (e && typeof e === "object" && "kind" in e ? String((e as { kind: string }).kind) : "error"); }

/** Title → Hosted Play: join an open table or host one. */
export function openLobby(): void {
  if (!available()) return;
  if (stop !== "terms" && stop !== "expired") stop = null;
  H = {
    room: null, socket: null, myPid: null, hostPid: null, isHost: false, participants: [], started: false, course: null, players: [],
    cmdSeq: 0, applied: {}, pending: {}, status: T("Connecting…"), failed: false,
  };
  const h = H;
  showScreen("lobby");
  void (async () => {
    let room: Room | null = null;
    try { room = await rooms.quickJoin({ teamCount: 1, seatsPerTeam: 2 }); }
    catch (e) { return fail(h, e, "Hosted play is unavailable right now ({error})."); }
    if (!room) {
      try {
        room = await rooms.create({ teamCount: 1, seatsPerTeam: 2, aiPlayers: 0, backfillAiPlayers: false, metadata: { courseId: "daily", seed: Content.dailySeed(platform.nowMs()) } });
        room = await rooms.open(room.id);
      } catch (e) { return fail(h, e, "Could not create a room ({error})."); }
    }
    if (H !== h) { void rooms.leave(room.id).catch(() => undefined); return; }
    h.room = room;
    adoptRoster(h, room);
    const socket = rooms.connect(room.id);
    h.socket = socket;
    socket.on("roster", (r) => { if (H === h) adoptRoster(h, r); });
    socket.on("data", (from, payload) => { if (H === h) onData(h, from, payload); });
    socket.on("stopped", (reason) => { if (H === h) onStopped(h, reason); });
  })();
}
function fail(h: Hosted, e: unknown, msg: string): void {
  if (H !== h) return;
  if (errKind(e) === "terms-required") { stop = "terms"; h.status = stopText("terms"); h.failed = true; return; }
  h.status = T(msg, { error: errKind(e) }) + " " + T("Practice against the deterministic AI instead — it is always available.");
  h.failed = true;
}
function adoptRoster(h: Hosted, room: Room): void {
  h.participants = room.participants.filter((p) => !p.isAi);
  const me = platform.userId();
  const mine = h.participants.find((p) => p.userId === me);
  if (mine) h.myPid = mine.id;
  const host = h.participants.find((p) => p.isHost);
  if (host) h.hostPid = host.id;
  h.isHost = !!mine && !!host && mine.id === host.id;
  if (h.started) return;
  h.status = h.participants.length < 2 ? T("Waiting for an opponent to join this room…")
    : h.isHost ? T("Opponent found — start when ready.") : T("Opponent found — waiting for the host to start.");
}

function send(h: Hosted, msg: Record<string, unknown>): boolean {
  if (!h.socket) return false;
  const bytes = enc.encode(JSON.stringify(msg));
  if (bytes.length > MAX_FRAME) return false;
  return h.socket.sendData(bytes);
}

/** Host: start the match on today's daily course. */
export function hostStart(): void {
  const h = H;
  if (!h || !h.isHost || h.started) return;
  const ids = h.participants.slice(0, 2).map((p) => p.id);
  if (ids.length < 2 || !h.myPid) { toast(() => T("Still waiting for an opponent")); return; }
  h.players = [h.myPid, ids.find((x) => x !== h.myPid) ?? ids[1]!];
  h.course = Content.dailyCourse(platform.nowMs());
  if (!send(h, { k: "start", course: h.course, players: h.players, seed: h.room!.id })) { toast(() => T("Could not reach the room")); return; }
  begin(h);
}
function begin(h: Hosted): void {
  h.started = true;
  startRound("hosted", [h.course!], { players: h.players, seed: h.room!.id });
}

function onData(h: Hosted, from: string, payload: Uint8Array): void {
  let msg: Record<string, unknown>;
  try { msg = JSON.parse(dec.decode(payload)) as Record<string, unknown>; } catch { return; }
  if (!msg || typeof msg !== "object") return;
  if (msg.k === "start") {
    if (h.isHost || h.started || from !== h.hostPid) return;
    if (!h.myPid) { toast(() => T("Could not confirm your seat — please rejoin")); leave(); return; }
    h.course = msg.course as Course;
    h.players = Array.isArray(msg.players) ? (msg.players as string[]).map(String) : [from, h.myPid];
    begin(h);
    return;
  }
  if (msg.k === "cmd" && h.isHost) { hostCommand(h, from, msg); return; }
  if (from !== h.hostPid) return; // results and rejections come only from the host
  if (msg.k === "res") { adoptResult(h, msg); return; }
  if (msg.k === "rej") {
    const id = String(msg.id);
    if (!h.pending[id]) return;
    delete h.pending[id];
    audio.event({ type: "invalid", reason: String(msg.error) });
    announce(T("Rejected: {reason}", { reason: audio.reasonText(String(msg.error)) }), true);
    G.machine = "active";
  }
}

/** Host-side authoritative apply: membership, turn, legality; idempotent by command id. */
function hostApply(h: Hosted, cmd: Command): { error?: string; duplicate?: boolean; state?: State; events?: GameEvent[]; trace?: TracePoint[] } {
  const sess = G.session;
  if (!cmd || typeof cmd !== "object") return { error: "malformed-command" };
  if (cmd.id && h.applied[cmd.id]) return { duplicate: true };
  if (!sess || sess.state.terminal) return { error: "session-expired" };
  const err = Rules.invalidReason(sess.state, cmd);
  if (err) return { error: err };
  const res = Rules.step(sess.state, sess.holes[sess.holeIndex]!, cmd);
  if (res.error) return { error: res.error };
  if (cmd.id) h.applied[cmd.id] = true;
  return { state: res.state, events: res.events, trace: res.trace };
}
function hostCommand(h: Hosted, from: string, msg: Record<string, unknown>): void {
  if (!G.session || !msg.cmd || typeof msg.cmd !== "object") return;
  // the seat is the sender's participant id, never one named in the payload
  const cmd = { ...(msg.cmd as Command), by: from };
  const out = hostApply(h, cmd);
  if (out.duplicate) { send(h, { k: "res", id: msg.id, by: from, state: G.session.state, events: [], trace: [] }); return; }
  if (out.error) { send(h, { k: "rej", id: msg.id, by: from, error: out.error }); return; }
  broadcast(h, String(msg.id), from, out);
  G.machine = "resolving";
  G.session.state = out.state!;
  handleResult({ events: out.events!, error: null, trace: out.trace! });
}
function broadcast(h: Hosted, id: string, by: string, out: { state?: State; events?: GameEvent[]; trace?: TracePoint[] }): void {
  if (send(h, { k: "res", id, by, state: out.state, events: out.events, trace: out.trace })) return;
  // over the frame cap: drop the roll trace; guests settle at once
  send(h, { k: "res", id, by, state: out.state, events: out.events, trace: null, lite: true });
}
function adoptResult(h: Hosted, msg: Record<string, unknown>): void {
  const sess = G.session;
  if (!sess) return;
  const id = String(msg.id);
  if (h.pending[id]) delete h.pending[id];
  else if (G.machine === "resolving") return; // never swap state out from under a roll in flight
  G.machine = "resolving";
  sess.state = msg.state as State;
  handleResult({ events: (msg.events as GameEvent[]) ?? [], error: null, trace: msg.lite ? [] : ((msg.trace as TracePoint[]) ?? []) });
}

/** The local player's stroke at a hosted table. */
export function submit(cmd: Command): void {
  const h = H;
  if (!h || !h.room) return;
  const full: Command = { ...cmd, id: h.room.id + "-" + (++h.cmdSeq) };
  if (h.isHost) {
    const out = hostApply(h, full);
    if (out.error) {
      audio.event({ type: "invalid", reason: out.error });
      announce(T("Rejected: {reason}", { reason: audio.reasonText(out.error) }), true);
      G.machine = "active";
      return;
    }
    broadcast(h, full.id!, full.by!, out);
    G.session!.state = out.state!;
    handleResult({ events: out.events!, error: null, trace: out.trace! });
    return;
  }
  h.pending[full.id!] = full;
  if (!send(h, { k: "cmd", id: full.id, cmd: full })) {
    delete h.pending[full.id!];
    toast(() => T("Connection issue — move not sent"));
    G.machine = "active";
  }
}

function onStopped(h: Hosted, reason: string): void {
  stop = reason === "terms-required" ? "terms" : reason === "signed-out" || reason === "forbidden" ? "expired" : "unavailable";
  for (const k of Object.keys(h.pending)) delete h.pending[k];
  if (!h.started) { h.status = T("The room connection was lost.") + (stop !== "unavailable" ? " " + stopText(stop) : ""); h.failed = true; return; }
  if (G.session && !G.session.state.terminal) {
    toast(() => T("Connection to the match was lost"));
    if (G.machine === "resolving") G.machine = "active";
  }
}

/** Leaves the table (the round, the lobby). */
export function leave(): void {
  const h = H;
  H = null;
  if (stop === "unavailable") stop = null;
  if (!h) return;
  try { h.socket?.close(); } catch { /* closed */ }
  if (h.room) void rooms.leave(h.room.id).catch(() => undefined);
}
export function leaveLobby(): void { leave(); showTitle(); }
/** The lobby's fallback: practice against the AI. */
export function practiceInstead(): void {
  leave();
  startRound("practice", [Content.AUTHORED[0]!], { players: ["you", "ai"] });
}
export function update(): void { /* sockets push their events; nothing to poll */ }
