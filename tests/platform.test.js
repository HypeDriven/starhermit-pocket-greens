'use strict';
// StarHermit adapter (platform.js) over the shared SDK with a stubbed fetch.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const SDK = require('../starhermit-sdk.js');

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const TOKEN = 'h.' + b64u({ sub: 'user-55cc66dd', game_scope: 'pg-slug', exp: Math.floor(Date.now() / 1000) + 3600 }) + '.s';

// Fresh copy of the adapter bound to a fresh SDK instance.
function install(href) {
	const calls = [];
	const saves = {};
	const kv = { audio: { music: 0.2 } };
	const fetch = async (url, init = {}) => {
		calls.push({ url, method: init.method || 'GET', init });
		const r = (status, body) => new Response(body, { status });
		const j = (o) => r(200, JSON.stringify(o));
		if (url === '/api/v1/users/user-55cc66dd/profile') return j({ username: 'hidden', nickname: 'Putter' });
		if (url.includes('/cloud-saves/')) {
			const key = decodeURIComponent(url.split('/cloud-saves/')[1]);
			if (init.method === 'PUT') { saves[key] = Buffer.from(JSON.parse(init.body).dataBase64, 'base64'); return j({}); }
			return saves[key] ? r(200, saves[key]) : r(404, '');
		}
		if (url.endsWith('/settings') && init.method === 'PATCH') { Object.assign(kv, JSON.parse(init.body).settings); return j({}); }
		if (url.endsWith('/settings')) return j({ settings: kv });
		if (url.endsWith('/controls')) return j({ actions: [{ action: 'strike', codes: ['KeyS'] }] });
		return r(404, '');
	};
	const u = new URL(href);
	const loc = { hash: u.hash, search: u.search, pathname: u.pathname, origin: u.origin, hostname: u.hostname, href };
	globalThis.StarHermit = SDK.create({ window: { location: loc, history: { replaceState() {} } }, fetch, setTimeout: () => 0, clearTimeout: () => {} });
	globalThis.fetch = fetch;
	const file = path.join(__dirname, '..', 'platform.js');
	delete require.cache[require.resolve(file)];
	const platform = require(file);
	platform.initAuth();
	return { platform, calls, saves, kv };
}

test('hosted: token, nickname, cloud save game:<slug>, settings, bindings', async () => {
	const { platform: P, calls, saves, kv } = install('https://pg-slug.starhermit.com/#game_token=' + TOKEN);
	assert.equal(P.state.hosted, true);
	assert.equal(P.state.sub, 'user-55cc66dd');
	assert.equal(P.state.slug, 'pg-slug');
	assert.equal(P.state.token, TOKEN);
	assert.equal(await P.nicknameFor('user-55cc66dd'), 'Putter');
	let who = null;
	P.onIdentity = (id) => { who = id; };
	await P.refreshIdentity();
	assert.deepEqual(who, { id: 'user-55cc66dd', name: 'Putter' });

	// cloud save: checksummed progress doc round-trips through game:<slug>
	const RULES = require('../rules');
	const doc = JSON.parse(JSON.stringify(P.DEFAULT_PROGRESS));
	doc.journey.unlocked = 3;
	doc.checksum = RULES.hashStr(RULES.stableStringify({ v: doc.version, journey: doc.journey, achievements: doc.achievements, mastery: doc.mastery }));
	P.queueCloudSave(doc);
	assert.equal(await P.flushCloudSave(), true);
	assert.deepEqual(Object.keys(saves), ['game:pg-slug']);
	assert.deepEqual(await P.loadAdoptedProgress({ local: true }), doc);

	// settings KV: remote wins on start, changed keys patched
	const merged = await P.loadRemoteSettings(JSON.parse(JSON.stringify(P.DEFAULT_SETTINGS)));
	assert.equal(merged.audio.music, 0.2);
	assert.equal(merged.audio.effects, P.DEFAULT_SETTINGS.audio.effects);
	merged.controls.leftHanded = true;
	await P.syncSettings(merged);
	const patches = calls.filter((c) => c.method === 'PATCH').map((c) => JSON.parse(c.init.body).settings);
	assert.ok(patches.some((p) => p.controls && p.controls.leftHanded === true));
	assert.equal(kv.controls.leftHanded, true);

	assert.deepEqual(await P.loadBindings({ strike: ['Space'], undo: ['KeyU'] }), { strike: ['KeyS'], undo: ['KeyU'] });
	assert.match(P.inviteLink(), /\/game-invite\/user-55cc66dd\/pg-slug$/);
	const res = await P.api('/api/v1/realtime/rooms/quick-join', { method: 'POST', body: {} });
	assert.deepEqual(res, { ok: true, data: null }, 'hosted REST rides the SDK (404 -> null)');
	assert.ok(calls.every((c) => c.init.headers.Authorization === 'Bearer ' + TOKEN));
});

test('standalone: no request at all (even on localhost)', async () => {
	const { platform: P, calls } = install('http://localhost:8080/');
	assert.equal(P.state.hosted, false);
	assert.equal(P.state.token, null);
	assert.equal(P.canSignIn(), false);
	assert.equal(P.inviteLink(), null);
	P.queueCloudSave({ a: 1 });
	assert.equal(await P.flushCloudSave(), false);
	assert.deepEqual(await P.loadAdoptedProgress({ local: true }), { local: true });
	const s = JSON.parse(JSON.stringify(P.DEFAULT_SETTINGS));
	assert.deepEqual(await P.loadRemoteSettings(s), s);
	assert.equal(await P.syncSettings(s), null);
	assert.deepEqual(await P.loadBindings({ strike: ['Space'] }), { strike: ['Space'] });
	assert.equal((await P.api('/api/v1/sessions', { method: 'POST', body: {} })).ok, false);
	assert.ok(Math.abs(P.now() - Date.now()) < 50);
	assert.equal(calls.length, 0);
});
