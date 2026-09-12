'use strict';
(function () {

// Pocket Greens — hosted multiplayer over StarHermit realtime rooms (host-routed).
// Lobby/matchmaking is REST; gameplay rides the realtime WebSocket. The HOST runs the
// same deterministic rules engine the local game and the dev server use; guests send
// their existing strike commands as binary JSON frames (≤8 KB) and adopt the snapshots
// the host broadcasts. Server frames carry a 16-byte sender participant id prefix,
// which is stripped here. Guests only ever send binary input frames — text frames are
// reserved for server pushes (roster) and host control.

const hasWindow = typeof window !== 'undefined';
const hasModule = typeof module !== 'undefined' && module.exports;

const MAX_FRAME = 8 * 1024;        // 8 KB per-frame cap (platform contract)
const SENDER_PREFIX_LEN = 16;      // server prefixes sender participant id bytes

function supported() { return hasWindow && typeof WebSocket !== 'undefined'; }

// ---------- participant id <-> 16-byte prefix ----------

function idToBytes(id) {
	const b = new Uint8Array(SENDER_PREFIX_LEN);
	const s = String(id || '');
	for (let i = 0; i < SENDER_PREFIX_LEN; i++) b[i] = i < s.length ? s.charCodeAt(i) : 0;
	return b;
}

function idFromBytes(b) {
	let s = '';
	for (let i = 0; i < SENDER_PREFIX_LEN && b[i]; i++) s += String.fromCharCode(b[i]);
	return s;
}

// ---------- REST (rooms) ----------

const ROOMS = '/api/v1/realtime/rooms';

function pickRoomId(data) {
	const d = (data && (data.room || data)) || {};
	return d.id || d.roomId || null;
}

function pickSelfId(data) {
	const d = (data && (data.room || data)) || {};
	const id = d.you || d.self || d.participantId || d.seatId || d.yourId || d.memberId;
	return id ? String(id) : null;
}

function pickHostId(data) {
	const d = (data && (data.room || data)) || {};
	const id = d.host || d.hostId || d.owner || d.ownerId || d.creator;
	return id ? String(id) : null;
}

// Host a table: create, then open it so quick-join can find it.
async function createRoom(platform, cfg) {
	const res = await platform.api(ROOMS, {
		method: 'POST',
		body: {
			gameSlug: cfg.slug,
			config: { teamCount: 1, seatsPerTeam: 2, metadata: cfg.metadata || {} },
			aiPlayers: 0,
		},
	});
	if (!res.ok) return res;
	const roomId = pickRoomId(res.data);
	if (!roomId) return { ok: false, error: 'bad-room-response' };
	const open = await platform.api(ROOMS + '/' + encodeURIComponent(roomId) + '/open', { method: 'POST', body: {} });
	if (!open.ok) return open;
	return { ok: true, roomId, selfId: pickSelfId(res.data), hostId: pickHostId(res.data) || pickSelfId(res.data) };
}

// Join an open table; null means "none open" and the caller should host one instead.
async function quickJoin(platform, slug) {
	const res = await platform.api(ROOMS + '/quick-join', { method: 'POST', body: { gameSlug: slug, seats: 1 } });
	if (res.status === 404) return null;
	if (!res.ok) return res;
	const roomId = pickRoomId(res.data);
	if (!roomId) return null;
	return { ok: true, roomId, selfId: pickSelfId(res.data), hostId: pickHostId(res.data) };
}

// ---------- roster parsing (server push shapes are parsed defensively) ----------

function extractRoster(msg) {
	if (!msg || typeof msg !== 'object') return null;
	const cand = msg.roster || msg.participants || msg.seats || msg.members ||
		(msg.room && (msg.room.roster || msg.room.participants)) ||
		(Array.isArray(msg) ? msg : null);
	if (!Array.isArray(cand)) return null;
	const ids = [];
	for (const p of cand) {
		const id = typeof p === 'string' ? p : (p && (p.id || p.participantId || p.userId || p.seatId));
		if (id) ids.push(String(id));
	}
	return ids.length ? ids : null;
}

function extractYou(msg) {
	if (!msg || typeof msg !== 'object') return null;
	const you = msg.you || msg.self || msg.yourId || (msg.me && (msg.me.id || msg.me)) || msg.participantId;
	return typeof you === 'string' && you ? you : null;
}

// ---------- WebSocket transport ----------

// handlers: { onOpen(), onRoster(ids), onMessage(senderId, obj), onText(msg), onClose() }
function RoomClient(platform, roomId, handlers) {
	this.platform = platform;
	this.roomId = roomId;
	this.handlers = handlers || {};
	this.ws = null;
	this.myId = null;
	this.roster = [];
}

RoomClient.prototype.connect = function () {
	const loc = window.location;
	const proto = loc.protocol === 'https:' ? 'wss' : 'ws';
	const url = proto + '://' + loc.host + '/ws/v1/realtime?roomId=' + encodeURIComponent(this.roomId) +
		'&access_token=' + encodeURIComponent(this.platform.state.token);
	const ws = new WebSocket(url);
	this.ws = ws;
	ws.binaryType = 'arraybuffer';
	const self = this;
	ws.onopen = function () { if (self.handlers.onOpen) self.handlers.onOpen(); };
	ws.onclose = function () { if (self.handlers.onClose) self.handlers.onClose(); };
	ws.onmessage = function (ev) {
		if (typeof ev.data === 'string') return self.handleText(ev.data);
		const bytes = new Uint8Array(ev.data);
		if (bytes.length < SENDER_PREFIX_LEN) return;
		const sender = idFromBytes(bytes.subarray(0, SENDER_PREFIX_LEN));
		let obj;
		try { obj = JSON.parse(new TextDecoder().decode(bytes.subarray(SENDER_PREFIX_LEN))); }
		catch (e) { return; }
		if (self.handlers.onMessage) self.handlers.onMessage(sender, obj);
	};
};

RoomClient.prototype.handleText = function (text) {
	let msg;
	try { msg = JSON.parse(text); } catch (e) { return; }
	const you = extractYou(msg);
	if (you) this.setMyId(you, false);
	const roster = extractRoster(msg);
	if (roster) {
		this.roster = roster;
		if (this.handlers.onRoster) this.handlers.onRoster(roster);
	}
	if (this.handlers.onText) this.handlers.onText(msg);
};

RoomClient.prototype.setMyId = function (id, announce) {
	if (this.myId || !id) return;
	this.myId = String(id);
	if (announce !== false && this.handlers.onRoster && this.roster.length) this.handlers.onRoster(this.roster);
};

// Binary JSON frame; false when it cannot go (oversized / not connected).
RoomClient.prototype.send = function (obj) {
	if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
	const data = new TextEncoder().encode(JSON.stringify(obj));
	if (data.length > MAX_FRAME - SENDER_PREFIX_LEN) return false;
	this.ws.send(data);
	return true;
};

RoomClient.prototype.leave = function () {
	try { if (this.ws) this.ws.close(); } catch (e) { /* already closed */ }
	return this.platform.api(ROOMS + '/' + encodeURIComponent(this.roomId) + '/leave', { method: 'POST', body: {} });
};

// Host reports the authoritative outcome when the round ends.
RoomClient.prototype.rest = function (result) {
	return this.platform.api(ROOMS + '/' + encodeURIComponent(this.roomId) + '/result', { method: 'POST', body: { result } });
};

const netApi = { supported, createRoom, quickJoin, RoomClient, idToBytes, idFromBytes, extractRoster, MAX_FRAME, SENDER_PREFIX_LEN };

if (hasModule) module.exports = netApi;
else { window.PG = window.PG || {}; window.PG.net = netApi; }
})();
