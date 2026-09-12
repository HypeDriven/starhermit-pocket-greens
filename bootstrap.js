'use strict';

// Pocket Greens — bootstrap: host handshake, capability detection, asset manifest, lifecycle.
// Owns the game-state machine:
// boot → title → mode-select → preparing → countdown → active ↔ paused → resolving → results → progression.
// Every transition happens here, with an explicit reason.

(function () {
	const PG = window.PG;
	const RULES = PG.rules, CONTENT = PG.content, SESSION = PG.session;
	const AUDIO = PG.audio, PLATFORM = PG.platform, RENDER = PG.render, UI = PG.ui, NET = PG.net;

	const G = {
		machine: 'boot',
		mode: null,
		session: null,
		aim: { angle: 0, power: 50, active: false },
		hint: null,
		learn: null,          // { tutorialId, step }
		hosted: null,         // { sessionId, playerId, poll }
		settings: null,
		progress: null,
		quality: 'medium',
		countdown: 0,
		transitionReason: '',
	};

	// ---------- state machine ----------

	function transition(to, reason) {
		G.machine = to;
		G.transitionReason = reason;
	}

	// ---------- settings ----------

	function applySettings() {
		const s = G.settings;
		AUDIO.setVolume('music', s.audio.music);
		AUDIO.setVolume('effects', s.audio.effects);
		AUDIO.setVolume('ambience', s.audio.ambience);
		AUDIO.setVolume('voice', s.audio.voice);
		AUDIO.setMuted(s.audio.muted);
		PLATFORM.setConsent(!!s.telemetry.consent);
		let tier = s.graphics.tier;
		if (tier === 'auto') {
			const cores = navigator.hardwareConcurrency || 4;
			const mobile = /Android|iPhone|iPad|Mobi/i.test(navigator.userAgent);
			tier = mobile ? (cores >= 6 ? 'medium' : 'low') : (cores >= 4 ? 'high' : 'medium');
		}
		G.quality = tier;
		RENDER.setQuality(tier);
		RENDER.setReducedMotion(!!s.graphics.reducedMotion || matchMedia('(prefers-reduced-motion: reduce)').matches);
		RENDER.setHighContrast(!!s.graphics.highContrast || s.graphics.palette !== 'default');
		UI.applySettingsToDom();
		PLATFORM.saveSettings(s);
	}

	// ---------- player identity ----------

	// The seat this client controls. Solo/practice sessions always seat the human as
	// 'you'; hosted matches use the platform participant id from the room.
	function localPlayerId() { return G.hosted ? G.hosted.playerId : 'you'; }
	function isOpponent(id) { return id !== localPlayerId(); }

	// Hosted names come from the account profile; resolve asynchronously and refresh.
	const nickCache = {};
	function nickFor(id) { return nickCache[id] || 'Player ' + String(id).slice(0, 8); }
	function primeNick(id) {
		if (!PLATFORM.state.hosted || !id || nickCache[id]) return;
		PLATFORM.nicknameFor(id).then(name => {
			nickCache[id] = name;
			refreshHud();
			renderRoomsLobby(G.lobbyRoster || []);
		}).catch(() => {});
	}
	function playerLabel(id) {
		if (isOpponent(id)) return (G.hosted && G.hosted.rooms) ? nickFor(id) : (G.hosted ? id : 'AI');
		return 'You';
	}

	// ---------- HUD refresh ----------

	function refreshHud() {
		const sess = G.session;
		if (!sess) return;
		const st = sess.state;
		const course = sess.holes[sess.holeIndex];
		const me = st.players[st.currentPlayer];
		const t = sess.totals[me.id] || { strokes: 0, penalties: 0, holes: 0 };
		const objective = G.learn
			? CONTENT.TUTORIALS.find(x => x.id === G.learn.tutorialId).title + ' — ' + G.learn.stepText
			: st.terminal ? 'Round complete'
			: st.phase === 'aim' ? (isOpponent(me.id) ? 'Opponent is aiming…' : 'Aim and strike')
			: 'Ball rolling…';
		UI.setHud({
			objective,
			hole: (sess.holeIndex + 1) + '/' + sess.holes.length,
			par: course.par,
			strokes: me.strokes + (me.penalties ? ' (+' + me.penalties + ')' : ''),
			total: t.strokes + t.penalties,
			playing: true,
		});
		const rows = Object.keys(sess.totals).map(id => {
			const tt = sess.totals[id];
			return '<p>' + playerLabel(id) + ': <b>' + (tt.strokes + tt.penalties) + '</b> over ' + tt.holes + ' hole(s)</p>';
		}).join('');
		UI.setRails(
			'<p>' + modeLabel() + '</p><p>Seed: <code>' + sess.seed + '</code></p>' + rows,
			st.phase === 'aim' && !isOpponent(me.id)
				? '<p>Drag back from the ball or use arrow keys. Power ' + Math.round(G.aim.power) + '%.</p>'
				: '<p>' + (isOpponent(me.id) ? 'Opponent turn' : 'Resolving…') + '</p>');
		const canAct = st.phase === 'aim' && !isOpponent(me.id) && !st.terminal;
		UI.setControls({
			canStrike: canAct,
			canUndo: canAct && sess.mode === 'practice' && sess.undone.length > 0,
			canHint: canAct,
		});
	}

	function modeLabel() {
		const m = { learn: 'Learn', journey: 'Journey', daily: 'Daily Challenge', practice: 'Practice', challenge: 'Challenge', hosted: 'Hosted match' };
		return m[G.mode] || G.mode;
	}

	// ---------- round lifecycle ----------

	function startRound(mode, holes, opts) {
		opts = opts || {};
		transition('preparing', 'start-' + mode);
		const players = opts.players || ['you'];
		G.mode = mode;
		RENDER.setPaused(false);
		if (mode !== 'learn') G.learn = null; // a lesson must not leak into the next round's HUD
		clearTimeout(G.countdownTimer);
		G.session = SESSION.newSession({
			id: 'local-' + Date.now().toString(36),
			seed: opts.seed || (mode + '-' + holes[0].id),
			holes, players, mode, challenge: opts.challenge || null,
		});
		AUDIO.setSeed(G.session.seed);
		const theme = CONTENT.getTheme(holes[0].theme);
		RENDER.loadCourse(holes[0], theme);
		RENDER.currentState = G.session.state;
		RENDER.applySnapshot(G.session.state);
		AUDIO.startAmbience(theme.ambience);
		PLATFORM.startActivity(mode);
		PLATFORM.track('start', { mode });
		// countdown keeps the "short path to play" explicit without blocking input long
		transition('countdown', 'round-ready');
		G.countdown = 2;
		UI.showScreen(null);
		UI.toast(holes[0].tutorial ? 'Lesson: ' + holes[0].tutorial : modeLabel() + ' — hole 1');
		G.countdownTimer = setTimeout(() => {
			// a pause taken during the countdown must survive it
			if (!G.session || G.machine !== 'countdown') return;
			transition('active', 'countdown-complete');
			afterTurn(); // hands off to the opponent when they open the hole
		}, G.settings.graphics.reducedMotion ? 100 : 900);
		refreshHud();
	}

	function currentCourse() { return G.session.holes[G.session.holeIndex]; }

	function defaultAim() {
		const st = G.session.state;
		const me = st.players[st.currentPlayer];
		const c = currentCourse();
		G.aim.angle = Math.atan2(c.cup.y - me.ball.y, c.cup.x - me.ball.x);
		G.aim.power = Math.min(70, Math.max(20, Math.hypot(c.cup.x - me.ball.x, c.cup.y - me.ball.y) * 8));
		UI.setPower(Math.round(G.aim.power));
		updateAimView();
	}

	function updateAimView() {
		const st = G.session.state;
		if (!st || st.phase !== 'aim') { RENDER.setAim(null); return; }
		const me = st.players[st.currentPlayer];
		RENDER.setAim(me.ball, G.aim.angle, G.aim.power);
	}

	// ---------- strokes ----------

	function strike() {
		const sess = G.session;
		if (!sess || sess.state.phase !== 'aim') return;
		const me = sess.state.players[sess.state.currentPlayer];
		if (isOpponent(me.id)) return;
		submitStrike({ type: 'strike', angle: G.aim.angle, power: G.aim.power, by: me.id });
	}

	function submitStrike(cmd) {
		const sess = G.session;
		if (G.hosted && G.hosted.rooms) { roomsSubmit(cmd); return; }
		if (G.hosted) { hostedSubmit(cmd); return; }
		transition('resolving', 'strike');
		RENDER.setAim(null);
		const res = SESSION.applyCommand(sess, cmd);
		handleResult(res);
	}

	function handleResult(res) {
		const sess = G.session;
		if (res.error) {
			AUDIO.event({ type: 'invalid', reason: res.error });
			UI.announce('Invalid action: ' + res.error, true);
			transition('active', 'invalid-command');
			refreshHud();
			return;
		}
		// Only the strike itself is acknowledged immediately; bounce/splash are fired by the
		// renderer at their simulated time (playing them here too would double the sound).
		for (const e of res.events) {
			if (e.type === 'strike') AUDIO.event(e);
		}
		RENDER.playTrace(res.trace, res.events, 1, () => {
			// playback finished: settle every object into the exact deterministic end state
			RENDER.currentState = sess.state;
			RENDER.applySnapshot(sess.state);
			let completed = false;
			for (const e of res.events) {
				if (e.type === 'holed' || e.type === 'capped' || e.type === 'round-complete') AUDIO.event(e);
				if (e.type === 'hole-summary') UI.announce(holeSummaryText(e), false);
				if (e.type === 'next-hole') onNextHole(sess.holes[sess.holeIndex]);
				if (e.type === 'session-complete') completed = true;
			}
			checkLearn(res.events);
			if (completed || sess.state.terminal) { finishRound(); return; }
			if (G.machine !== 'paused') transition('active', 'resolution-complete');
			afterTurn();
		});
	}

	function holeSummaryText(e) {
		const parts = Object.keys(e.totals).map(id => playerLabel(id) + ' ' + (e.totals[id].strokes + e.totals[id].penalties));
		return 'Hole finished. ' + parts.join(', ') + '.';
	}

	function onNextHole(course) {
		const theme = CONTENT.getTheme(course.theme);
		RENDER.loadCourse(course, theme);
		AUDIO.stopAmbience();
		AUDIO.startAmbience(theme.ambience);
		UI.toast('Hole ' + (G.session.holeIndex + 1) + ' — par ' + course.par);
	}

	function afterTurn() {
		const sess = G.session;
		if (!sess || G.machine === 'paused') return;
		const st = sess.state;
		if (st.terminal) { finishRound(); return; }
		const me = st.players[st.currentPlayer];
		if (isOpponent(me.id)) {
			refreshHud();
			RENDER.setAim(null);
			// hosted rooms: a human opponent — the host broadcasts their move; wait for it.
			// local practice: the deterministic AI takes the other side after a short beat.
			if (G.hosted && G.hosted.rooms) return;
			clearTimeout(G.opponentTimer);
			G.opponentTimer = setTimeout(() => {
				if (!G.session || G.session !== sess || G.machine === 'paused') return;
				const cur = sess.state.players[sess.state.currentPlayer];
				if (!cur || !isOpponent(cur.id) || sess.state.phase !== 'aim') return;
				const cmd = SESSION.aiStrike(sess, cur.id);
				if (!cmd) return;
				transition('resolving', 'ai-strike');
				if (G.hosted) { hostedSubmit(cmd); return; }
				handleResult(SESSION.applyCommand(sess, cmd));
			}, G.settings.graphics.reducedMotion ? 150 : 800);
			return;
		}
		defaultAim();
		refreshHud();
	}

	// ---------- results & progression ----------

	function finishRound() {
		const sess = G.session;
		if (!sess || G.machine === 'results') return; // idempotent: only one results screen per round
		transition('results', 'round-complete');
		AUDIO.event({ type: 'session-complete' });
		clearTimeout(G.opponentTimer);
		if (G.hosted && G.hosted.poll) clearTimeout(G.hosted.poll);
		PLATFORM.stopActivity();
		PLATFORM.track('round-end', { mode: G.mode });
		// Hosted rounds terminate inside the server's state, so the session never builds
		// its own result envelope; derive one from the authoritative terminal block.
		if (!sess.result && sess.state.terminal) {
			sess.result = {
				reason: sess.state.terminal.reason,
				results: sess.state.terminal.results.map(x => Object.assign({ holes: 1 }, x)),
				challenge: sess.challenge ? { id: sess.challenge.id, status: sess.challengeStatus || 'passed' } : null,
				perHole: sess.holes.map(h => ({ id: h.id, par: h.par })),
			};
		}
		if (!sess.result || !sess.result.results.length) { UI.toast('Round ended unexpectedly'); leave(); return; }
		if (G.hosted && G.hosted.rooms && G.hosted.isHost) {
			// the host reports the authoritative outcome; guests see the same terminal state
			G.hosted.client.rest(sess.result).catch(() => {});
		}
		const unlocked = awardProgress(sess);
		const r = sess.result;
		const mine = r.results.find(x => x.id === localPlayerId()) || r.results[0];
		const parTotal = sess.holes.reduce((a, h) => a + h.par, 0);
		const headline = G.mode === 'challenge' && r.challenge
			? (r.challenge.status === 'passed' ? 'Challenge passed' : 'Challenge not met')
			: (mine.total <= parTotal ? 'Under or at par — nicely played' : 'Round complete');
		UI.renderResults(r, {
			headline: headline + ' — ' + mine.total + ' vs par ' + parTotal,
			unlocked,
			nextLabel: nextAction().label,
			showNext: !!nextAction().label,
		});
		UI.openOverlay('overlay-results');
		UI.announce(headline + '. Total ' + mine.total + '.', true);
	}

	function awardProgress(sess) {
		const p = G.progress;
		const unlocked = [];
		const mine = sess.result.results.find(r => r.id === localPlayerId()) || sess.result.results[0];
		const holedAny = sess.state.players.some(r => !isOpponent(r.id) && r.holed);
		if (holedAny && PLATFORM.unlockAchievement(p, 'first_hole')) unlocked.push('First Cup');
		p.mastery.holesCompleted += mine.holes || 0;
		if (p.mastery.holesCompleted >= 100 && PLATFORM.unlockAchievement(p, 'century')) unlocked.push('Century of Putts');
		if (mine.penalties === 0) p.mastery.noPenaltyHoles += mine.holes || 0;
		const streak = PLATFORM.recordHoleStreak(p, mine.holes || 0, mine.total,
			sess.holes.reduce((a, h) => a + h.par, 0));
		if (streak) unlocked.push(streak);
		if (G.mode === 'journey') {
			const stage = sess.holes[0].id;
			const idx = CONTENT.JOURNEY.indexOf(sess.holes[0]);
			if (!p.journey.stars[stage] || mine.total < p.journey.stars[stage]) p.journey.stars[stage] = mine.total;
			if (idx >= 0 && idx + 2 > p.journey.unlocked) p.journey.unlocked = Math.min(CONTENT.JOURNEY.length, idx + 2);
			const done = Object.keys(p.journey.stars).length;
			if (done >= 22 && PLATFORM.unlockAchievement(p, 'journey_half')) unlocked.push('Half the Garden');
		}
		if (G.mode === 'learn' && G.learn && holedAny) {
			G.settings.tutorial.completed[G.learn.tutorialId] = true;
			const allDone = CONTENT.TUTORIALS.every(t => G.settings.tutorial.completed[t.id]);
			if (allDone && PLATFORM.unlockAchievement(p, 'mechanic_master')) unlocked.push('Course Mechanic');
			PLATFORM.saveSettings(G.settings);
		}
		if (G.mode === 'daily') {
			if (!p.mastery.bestDaily || mine.total < p.mastery.bestDaily) p.mastery.bestDaily = mine.total;
			submitDailyScore(mine);
		}
		PLATFORM.saveProgress(p);
		return unlocked;
	}

	async function submitDailyScore(mine) {
		// Platform leaderboards are script-owned: clients never submit scores hosted.
		// The dev server accepts submissions for local testing only.
		if (PLATFORM.state.hosted) return;
		// Leaderboard submission includes ruleset, content version, seed, assists, duration.
		const res = await PLATFORM.api('/api/v1/leaderboard', {
			method: 'POST',
			body: {
				board: 'daily', seed: CONTENT.dailySeed(), rulesVersion: RULES.RULES_VERSION,
				contentVersion: CONTENT.CONTENT_VERSION, score: mine.total,
				assists: G.settings.controls.timingAssist ? ['timing'] : [], durationMs: G.session.elapsedMs,
			},
		});
		if (res.ok && res.data.rank) UI.toast('Daily rank: #' + res.data.rank);
		else if (!res.ok && !res.offline) UI.toast('Score not accepted: ' + res.error);
	}

	function nextAction() {
		if (G.mode === 'journey' && G.session) {
			const idx = CONTENT.JOURNEY.indexOf(G.session.holes[0]);
			if (idx >= 0 && idx + 1 < CONTENT.JOURNEY.length) return { label: 'Next stage', run: () => openSetup('journey', idx + 1) };
		}
		if (G.mode === 'learn' && G.learn) {
			const ti = CONTENT.TUTORIALS.findIndex(t => t.id === G.learn.tutorialId);
			const next = CONTENT.TUTORIALS[ti + 1];
			if (next) return { label: 'Next lesson', run: () => startLearn(next.id) };
		}
		return { label: null, run: null };
	}

	// ---------- learn ----------

	function startLearn(tutorialId) {
		const hole = CONTENT.AUTHORED.find(c => c.tutorial === tutorialId) || CONTENT.AUTHORED[0];
		G.learn = { tutorialId, step: 0, stepText: '' };
		startRound('learn', [hole], { seed: 'learn-' + tutorialId });
		const tut = CONTENT.TUTORIALS.find(t => t.id === tutorialId);
		G.learn.stepText = tut.steps[0].text;
		UI.announce(tut.title + '. ' + tut.steps[0].text, false);
		PLATFORM.track('tutorial-step', { step: tutorialId + ':0' });
		setTimeout(refreshHud, 100);
	}

	function checkLearn(events) {
		if (!G.learn) return;
		const tut = CONTENT.TUTORIALS.find(t => t.id === G.learn.tutorialId);
		const stepDef = tut.steps[G.learn.step];
		if (!stepDef) return;
		const hit = events.some(e =>
			(stepDef.require === 'strike' && e.type === 'strike') ||
			(stepDef.require === 'holed' && e.type === 'holed'));
		if (hit && G.learn.step + 1 < tut.steps.length) {
			G.learn.step += 1;
			G.learn.stepText = tut.steps[G.learn.step].text;
			UI.toast(tut.steps[G.learn.step].text);
			UI.announce(tut.steps[G.learn.step].text, false);
			PLATFORM.track('tutorial-step', { step: tut.id + ':' + G.learn.step });
		}
	}

	// ---------- mode setup screens ----------

	let setupCtx = null;

	function openSetup(mode, preset) {
		transition('mode-select', 'menu-' + mode);
		setupCtx = { mode, preset };
		if (mode === 'journey') {
			const unlocked = G.progress.journey.unlocked;
			const idx = preset != null ? preset : Math.min(unlocked - 1, CONTENT.JOURNEY.length - 1);
			setupCtx.index = idx;
			// 44 stages can't fit on small screens as buttons; a native select keeps every
			// stage reachable (locked ones disabled) without overflowing the viewport.
			const options = CONTENT.JOURNEY.map((c, i) => {
				const locked = i >= unlocked;
				const best = G.progress.journey.stars[c.id];
				return '<option value="' + i + '"' + (locked ? ' disabled' : '') + (i === idx ? ' selected' : '') + '>' +
					(i + 1) + '. par ' + c.par + (best ? ' ★' + best : '') + (locked ? ' — locked' : '') + '</option>';
			}).join('');
			UI.renderSetup({
				title: 'Journey', desc: '44 stages that introduce one concept at a time, then combine them. Mastery stages every chapter.',
				duration: '~2 minutes per stage', players: '1', assists: 'Hints available', ranked: false,
				extra: 'Unlocked: ' + unlocked + ' / ' + CONTENT.JOURNEY.length,
				gridHtml: '<div class="setting-row"><label for="setup-stage">Stage</label>' +
					'<select id="setup-stage" aria-label="Stages">' + options + '</select></div>',
			});
			const stageSel = document.getElementById('setup-stage');
			stageSel.addEventListener('change', () => {
				setupCtx.index = Number(stageSel.value);
				UI.toast('Stage ' + (setupCtx.index + 1) + ' selected');
			});
		} else if (mode === 'daily') {
			UI.renderSetup({
				title: 'Daily Challenge', desc: 'One shared seed and ruleset per UTC day, synchronized to platform time. Everyone plays the same green.',
				duration: '~2 minutes', players: '1',
				assists: PLATFORM.state.hosted ? 'No undo • best recorded to your account' : 'No undo',
				ranked: !PLATFORM.state.hosted,
				extra: 'Seed: ' + CONTENT.dailySeed() + (PLATFORM.state.timeSynced ? ' (server time)' : ' (local clock)') +
					(PLATFORM.state.hosted ? ' • Platform boards are read-only' : ''),
			});
		} else if (mode === 'practice') {
			const grid = CONTENT.AUTHORED.map((c, i) =>
				'<button data-idx="' + i + '">' + c.id + ' par ' + c.par + '</button>').join('');
			UI.renderSetup({
				title: 'Practice', desc: 'Any hole, restart and undo freely, deterministic AI opponent optional. Never affects rating.',
				duration: 'As long as you like', players: '1 (AI optional)', assists: 'Undo + hints', ranked: false,
				gridHtml: '<div class="setting-row"><label>AI opponent</label><input type="checkbox" id="setup-ai"></div>' +
					'<div class="grid" role="group" aria-label="Practice holes">' + grid + '</div>',
			});
			setupCtx.index = 0;
			document.querySelectorAll('#setup-body [data-idx]').forEach(b =>
				b.addEventListener('click', () => { setupCtx.index = Number(b.dataset.idx); }));
		} else if (mode === 'challenge') {
			const grid = CONTENT.CHALLENGES.map((ch, i) =>
				'<button data-idx="' + i + '"><b>' + ch.name + '</b><br><small>' + ch.desc + '</small></button>').join('');
			UI.renderSetup({
				title: 'Challenges', desc: 'Constrained goals: move limits, speed targets, restricted power.',
				duration: '~1 minute each', players: '1', assists: 'None', ranked: false,
				gridHtml: '<div class="grid" role="group" aria-label="Challenges">' + grid + '</div>',
			});
			setupCtx.index = 0;
			document.querySelectorAll('#setup-body [data-idx]').forEach(b =>
				b.addEventListener('click', () => { setupCtx.index = Number(b.dataset.idx); }));
		}
		UI.showScreen('screen-setup');
	}

	function setupStart() {
		const { mode, index } = setupCtx;
		if (mode === 'journey') startRound('journey', [CONTENT.JOURNEY[index || 0]], {});
		else if (mode === 'daily') startRound('daily', [CONTENT.dailyCourse()], { seed: CONTENT.dailySeed() });
		else if (mode === 'practice') {
			const ai = document.getElementById('setup-ai') && document.getElementById('setup-ai').checked;
			startRound('practice', [CONTENT.AUTHORED[index || 0]], { players: ai ? ['you', 'ai'] : ['you'] });
		} else if (mode === 'challenge') {
			startRound('challenge', [CONTENT.CHALLENGES[index || 0].course], { challenge: CONTENT.CHALLENGES[index || 0] });
		}
	}

	// ---------- hosted play ----------

	// Two hosted paths, chosen by environment: with a platform launch token the game
	// uses StarHermit realtime rooms (host-routed over the realtime WebSocket); without
	// one it uses the bundled dev server's REST sessions (local play/testing only).
	function openLobby() {
		if (PLATFORM.state.hosted && NET.supported()) { openRoomsLobby(); return; }
		openDevLobby();
	}

	function addPracticeFallback(body) {
		if (body.querySelector('button')) return;
		const b = document.createElement('button');
		b.className = 'primary';
		b.textContent = 'Practice vs AI';
		b.addEventListener('click', () => startRound('practice', [CONTENT.AUTHORED[0]], { players: ['you', 'ai'] }));
		body.appendChild(b);
	}

	// --- realtime rooms (hosted) ---

	async function openRoomsLobby() {
		transition('mode-select', 'menu-hosted');
		UI.showScreen('screen-lobby');
		const body = document.getElementById('lobby-body');
		body.innerHTML = '<p>Connecting…</p>';
		const slug = PLATFORM.state.slug;
		let joined = await NET.quickJoin(PLATFORM, slug);
		let isHost = false;
		if (joined && !joined.ok) {
			body.innerHTML = '<p>Hosted play is unavailable right now (' + UI.escapeHtml(joined.error || 'error') + ').</p>' +
				'<p>Practice against the deterministic AI instead — it is always available.</p>';
			addPracticeFallback(body);
			return;
		}
		if (!joined) {
			// no open table: host one and wait for an opponent
			const made = await NET.createRoom(PLATFORM, {
				slug,
				metadata: { courseId: CONTENT.dailyCourse().id, seed: CONTENT.dailySeed() },
			});
			if (!made.ok) {
				body.innerHTML = '<p>Could not create a room (' + UI.escapeHtml(made.error || 'error') + ').</p>';
				addPracticeFallback(body);
				return;
			}
			joined = made;
			isHost = true;
		}
		const client = new NET.RoomClient(PLATFORM, joined.roomId, {
			onRoster: (ids) => renderRoomsLobby(ids),
			onMessage: (sender, msg) => roomsOnMessage(sender, msg),
			onText: (msg) => {
				// learn the host's participant id from any push that carries it
				const h = G.hosted;
				if (h && !h.hostId && msg && msg.hostId) h.hostId = String(msg.hostId);
			},
			onClose: () => roomsOnClose(),
		});
		G.hosted = {
			rooms: true, client, roomId: joined.roomId, hostId: joined.hostId || null,
			myId: joined.selfId || null, playerId: joined.selfId || null, isHost,
			course: null, players: null, cmdSeq: 0, applied: {}, pending: {}, started: false,
		};
		client.connect();
		body.innerHTML = '<p>Room <code>' + UI.escapeHtml(joined.roomId) + '</code> — connecting…</p>';
	}

	function renderRoomsLobby(ids) {
		const h = G.hosted;
		if (!h || !h.rooms || h.started) return;
		G.lobbyRoster = ids;
		if (!h.myId && ids.length) {
			// fall back to roster inference when the server did not name "you"
			h.myId = h.hostId
				? (ids.indexOf(h.hostId) >= 0 ? ids.find(x => x !== h.hostId) || h.hostId : ids[0])
				: (h.isHost ? ids[0] : null);
		}
		if (h.isHost) h.hostId = h.hostId || h.myId || ids[0];
		if (!h.playerId) h.playerId = h.myId;
		ids.slice(0, 2).forEach(primeNick);
		const names = ids.slice(0, 2).map(id =>
			'<li>' + UI.escapeHtml(nickFor(id)) + (id === h.myId ? ' (you)' : '') + '</li>').join('');
		let html = '<p>Room <code>' + UI.escapeHtml(h.roomId) + '</code></p><ul>' + names + '</ul>';
		if (ids.length < 2) html += '<p>Waiting for an opponent to join this room…</p>';
		else if (h.isHost) html += '<p>Opponent found — start when ready.</p>';
		else html += '<p>Opponent found — waiting for the host to start.</p>';
		const body = document.getElementById('lobby-body');
		body.innerHTML = html;
		if (ids.length >= 2 && h.isHost) {
			const b = document.createElement('button');
			b.className = 'primary';
			b.textContent = 'Start match';
			b.addEventListener('click', () => hostStartMatch());
			body.appendChild(b);
		}
		addPracticeFallback(body);
	}

	function hostStartMatch() {
		const h = G.hosted;
		if (!h || !h.isHost || h.started) return;
		const ids = (G.lobbyRoster || []).slice(0, 2);
		if (ids.length < 2 || !h.myId) { UI.toast('Still waiting for an opponent'); return; }
		h.hostId = h.myId;
		h.players = [h.myId, ids.find(x => x !== h.myId) || ids[1]];
		h.course = CONTENT.dailyCourse();
		if (!h.client.send({ k: 'start', course: h.course, players: h.players, seed: CONTENT.dailySeed() })) {
			UI.toast('Could not reach the room');
			return;
		}
		beginRoomsMatch();
	}

	function beginRoomsMatch() {
		const h = G.hosted;
		if (!h || h.started) return;
		h.started = true;
		h.playerId = h.myId;
		enterHosted();
	}

	function roomsOnMessage(sender, msg) {
		const h = G.hosted;
		if (!h || !h.rooms || !msg || typeof msg !== 'object') return;
		if (msg.k === 'start') {
			if (h.isHost) return; // the host already began locally
			h.course = msg.course;
			h.players = msg.players || [sender];
			h.hostId = h.hostId || (msg.players && msg.players[0]) || sender;
			if (!h.myId) { UI.toast('Could not confirm your seat — please rejoin'); h.client.leave(); return; }
			beginRoomsMatch();
			return;
		}
		if (msg.k === 'cmd' && h.isHost) { roomsHostCommand(msg); return; }
		if (msg.k === 'res') { roomsAdoptResult(msg); return; }
		if (msg.k === 'rej') {
			if (h.pending && h.pending[msg.id]) {
				delete h.pending[msg.id];
				AUDIO.event({ type: 'invalid', reason: msg.error });
				UI.announce('Rejected: ' + msg.error, true);
				transition('active', 'server-rejected');
				refreshHud();
			}
			return;
		}
	}

	// Host-side authoritative apply: same validation the dev server performs
	// (membership/turn/legality), idempotent by command id.
	function roomsHostApply(cmd) {
		const sess = G.session, h = G.hosted;
		if (!cmd || typeof cmd !== 'object') return { error: 'malformed-command' };
		if (cmd.id && h.applied[cmd.id]) return { duplicate: true, state: sess.state, events: [], trace: [] };
		if (!sess || sess.state.terminal) return { error: 'session-expired' };
		const err = RULES.invalidReason(sess.state, cmd);
		if (err) return { error: err };
		const res = RULES.step(sess.state, currentCourse(), cmd);
		if (res.error) return { error: res.error };
		if (cmd.id) h.applied[cmd.id] = true;
		return { state: res.state, events: res.events, trace: res.trace };
	}

	function roomsHostCommand(msg) {
		const h = G.hosted;
		if (!G.session || !msg.cmd) return;
		const out = roomsHostApply(msg.cmd);
		if (out.duplicate) { h.client.send({ k: 'res', id: msg.id, by: msg.cmd.by, state: out.state, events: [], trace: [] }); return; }
		if (out.error) { h.client.send({ k: 'rej', id: msg.id, by: msg.cmd.by, error: out.error }); return; }
		broadcastRes(msg.id, msg.cmd.by, out);
		if (isOpponent(msg.cmd.by)) {
			// the guest's stroke: adopt, animate, and hand the turn back
			transition('resolving', 'opponent-strike');
			RENDER.setAim(null);
			G.session.state = out.state;
			handleResult({ events: out.events, error: null, trace: out.trace });
		}
	}

	function broadcastRes(id, by, out) {
		const h = G.hosted;
		const full = { k: 'res', id, by, state: out.state, events: out.events, trace: out.trace };
		if (h.client.send(full)) return;
		// over the 8 KB frame cap: drop the roll trace; guests settle instantly instead
		h.client.send({ k: 'res', id, by, state: out.state, events: out.events, trace: null, lite: true });
	}

	function roomsSubmit(cmd) {
		const h = G.hosted;
		const full = Object.assign({ id: h.roomId + '-' + (++h.cmdSeq) }, cmd);
		transition('resolving', 'strike');
		RENDER.setAim(null);
		if (h.isHost) {
			const out = roomsHostApply(full);
			if (out.error) {
				AUDIO.event({ type: 'invalid', reason: out.error });
				UI.announce('Rejected: ' + out.error, true);
				transition('active', 'invalid-command');
				refreshHud();
				return;
			}
			broadcastRes(full.id, full.by, out);
			G.session.state = out.state;
			handleResult({ events: out.events, error: null, trace: out.trace });
			return;
		}
		h.pending[full.id] = full;
		if (!h.client.send({ k: 'cmd', id: full.id, cmd: full })) {
			delete h.pending[full.id];
			UI.toast('Connection issue — move not sent');
			transition('active', 'move-not-sent');
			refreshHud();
		}
	}

	function roomsAdoptResult(msg) {
		const h = G.hosted, sess = G.session;
		if (!sess) return;
		const mine = h.pending && h.pending[msg.id];
		if (mine) delete h.pending[msg.id];
		else {
			// the opponent's stroke, broadcast by the host
			if (G.machine === 'resolving') return; // never swap state out from under an in-flight roll
			transition('resolving', 'opponent-strike');
			RENDER.setAim(null);
		}
		// lite frames (over the 8 KB cap) carry no trace: playback settles instantly
		sess.state = msg.state;
		handleResult({ events: msg.events || [], error: null, trace: msg.lite ? [] : (msg.trace || []) });
	}

	function roomsOnClose() {
		const h = G.hosted;
		if (!h || !h.rooms) return;
		if (!h.started) {
			G.hosted = null;
			G.lobbyRoster = null;
			const body = document.getElementById('lobby-body');
			if (body && !G.session) {
				body.innerHTML = '<p>The room connection was lost.</p>';
				addPracticeFallback(body);
			}
			return;
		}
		if (G.session && !G.session.state.terminal) {
			UI.toast('Connection to the match was lost');
			if (h.pending) Object.keys(h.pending).forEach(k => delete h.pending[k]);
			if (G.machine === 'resolving') { transition('active', 'connection-lost'); refreshHud(); }
		}
	}

	// --- dev-server sessions (local play only; routes 404 on the platform) ---

	async function openDevLobby() {
		transition('mode-select', 'menu-hosted');
		UI.showScreen('screen-lobby');
		const body = document.getElementById('lobby-body');
		body.innerHTML = '<p>Connecting…</p>';
		const res = await PLATFORM.api('/api/v1/sessions', {
			method: 'POST',
			body: { courseIds: [CONTENT.dailyCourse().id], seed: CONTENT.dailySeed(), players: 2 },
		});
		if (!res.ok) {
			body.innerHTML = '<p>Hosted play needs the game server. ' + (res.offline ? 'You appear to be offline.' : 'Error: ' + res.error) + '</p>' +
				'<p>Practice against the deterministic AI instead — it is always available offline.</p>';
			addPracticeFallback(body);
			return;
		}
		// Seat ids come from the server: the local session must use them so turn order,
		// command `by` fields and the score rails all line up with the authoritative state.
		G.hosted = { sessionId: res.data.id, playerId: res.data.you, course: res.data.course, players: res.data.players };
		body.innerHTML = '<p>Match <code>' + res.data.id + '</code> ready. You are <b>' + res.data.you + '</b>. ' +
			'Strokes alternate; the server is authoritative and your result is submitted automatically.</p>' +
			'<div id="lobby-status"><p>Waiting for your turn…</p></div>';
		const start = document.createElement('button');
		start.className = 'primary';
		start.textContent = 'Enter match';
		start.addEventListener('click', enterHosted);
		body.appendChild(start);
	}

	function enterHosted() {
		const h = G.hosted;
		if (!h) return;
		h.course = h.course && h.course.course ? h.course.course : h.course;
		startRound('hosted', [h.course], { players: (h.players && h.players.length) ? h.players : [h.playerId], seed: h.sessionId || h.roomId });
		if (!h.rooms) hostedSync(); // rooms matches ride the WebSocket instead of polling
	}

	async function hostedSync() {
		const h = G.hosted;
		if (!h) return;
		const res = await PLATFORM.api('/api/v1/sessions/' + h.sessionId);
		if (G.hosted !== h) return; // left the match while the poll was in flight
		if (!res.ok) { UI.toast('Connection issue — retrying'); scheduleHostedPoll(); return; }
		const s = res.data;
		h.players = s.players;
		// Never swap state out from under an in-flight roll; adopt only between strokes.
		if (G.session && s.state && s.state.tick > G.session.state.tick && G.machine === 'active') {
			// reconnect path: REST session detail is the source of truth
			G.session.state = s.state;
			RENDER.currentState = s.state;
			RENDER.applySnapshot(s.state);
			UI.toast('While you were away: ' + (s.movesSince || 0) + ' move(s)');
		}
		refreshHud();
		scheduleHostedPoll();
	}

	function scheduleHostedPoll() {
		const h = G.hosted;
		if (!h) return;
		clearTimeout(h.poll);
		h.poll = setTimeout(hostedSync, 2000);
	}

	let hostedCmdSeq = 0;
	async function hostedSubmit(cmd) {
		const h = G.hosted;
		// stable command id so a retried POST is replayed idempotently by the server
		const full = Object.assign({ id: h.sessionId + '-' + (++hostedCmdSeq) }, cmd);
		const res = await PLATFORM.api('/api/v1/sessions/' + h.sessionId + '/commands', { method: 'POST', body: full });
		if (G.hosted !== h || !G.session) return; // a response must belong to this match
		if (!res.ok) {
			AUDIO.event({ type: 'invalid', reason: res.error });
			UI.announce('Rejected: ' + res.error, true);
			transition('active', 'server-rejected');
			refreshHud();
			return;
		}
		// server is authoritative; adopt its state and animate from its trace
		G.session.state = res.data.state;
		transition('resolving', 'strike');
		RENDER.setAim(null);
		// handleResult finishes the round itself once playback has settled; finishing here
		// as well would open the results screen over a still-rolling ball.
		handleResult({ events: res.data.events, error: null, trace: res.data.trace });
	}

	// ---------- pause / resume / leave ----------

	function pause() {
		if (!G.session || G.machine === 'results') return;
		if (UI.anyOverlayOpen()) return;
		transition('paused', 'user-pause');
		RENDER.setPaused(true);
		UI.openOverlay('overlay-pause');
	}

	function resume() {
		UI.closeOverlay('overlay-pause');
		RENDER.setPaused(false);
		transition(RENDER.isPlaying() ? 'resolving' : 'active', 'user-resume');
		if (RENDER.isPlaying()) refreshHud(); else afterTurn();
	}

	function leave() {
		UI.closeOverlay('overlay-pause');
		UI.closeOverlay('overlay-results');
		if (G.hosted && G.hosted.rooms) G.hosted.client.leave();
		if (G.hosted && G.hosted.poll) clearTimeout(G.hosted.poll);
		clearTimeout(G.countdownTimer);
		clearTimeout(G.opponentTimer);
		G.hosted = null;
		G.lobbyRoster = null;
		G.session = null;
		RENDER.setPaused(false);
		G.learn = null;
		AUDIO.stopAmbience();
		PLATFORM.stopActivity();
		// the HUD belongs to a round: reset it so no stale score or live Pause button remains
		RENDER.setAim(null);
		UI.setHud({ objective: 'Pocket Greens', hole: '–', par: '–', strokes: 0, total: 0, playing: false });
		UI.setControls({ canStrike: false, canUndo: false, canHint: false });
		UI.setRails('Choose a mode to begin.', '');
		transition('title', 'user-leave');
		updateTitle();
		UI.showScreen('screen-title');
	}

	// ---------- input ----------

	function bindInput() {
		const canvas = document.getElementById('game-canvas');
		let drag = null;

		function canvasPoint(e) {
			const r = canvas.getBoundingClientRect();
			return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
		}

		canvas.addEventListener('pointerdown', (e) => {
			AUDIO.resume();
			if (!canAim()) return;
			canvas.setPointerCapture(e.pointerId);
			drag = { id: e.pointerId, start: canvasPoint(e), moved: false };
			AUDIO.event({ type: 'ui' });
		});
		canvas.addEventListener('pointermove', (e) => {
			if (!drag || drag.id !== e.pointerId || !canAim()) return;
			const p = canvasPoint(e);
			const px = (p.x - drag.start.x) * canvas.clientWidth, py = (p.y - drag.start.y) * canvas.clientHeight;
			const dist = Math.hypot(px, py);
			if (dist < 12 && !drag.moved) return; // tap/drag threshold
			drag.moved = true;
			// slingshot: pull back to aim the opposite way; distance sets power.
			// The delta is mapped through the camera so the drag matches what is on screen.
			const d = RENDER.courseDelta(px, py);
			G.aim.angle = Math.atan2(-d.y, -d.x);
			G.aim.power = Math.max(1, Math.min(100, (dist / Math.min(canvas.clientWidth, canvas.clientHeight)) * 160));
			UI.setPower(Math.round(G.aim.power));
			updateAimView();
			AUDIO.event({ type: 'aim-tick' });
			if (G.settings.controls.haptics && navigator.vibrate) navigator.vibrate(3);
		});
		function endDrag(e) {
			if (!drag || drag.id !== e.pointerId) return;
			const wasDrag = drag.moved;
			drag = null;
			if (!canAim()) return;
			if (wasDrag) strike(); // release commits; Esc before release cancels
		}
		canvas.addEventListener('pointerup', endDrag);
		canvas.addEventListener('pointercancel', () => { drag = null; }); // cancel safely on lost capture

		document.addEventListener('keydown', (e) => {
			if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) && e.target.type !== 'range') return;
			const k = e.key;
			if (k === 'Escape') {
				// Esc during a pull-back abandons the stroke (as Help documents) before it pauses
				if (drag) { drag = null; defaultAim(); refreshHud(); }
				else if (UI.anyOverlayOpen()) { emitCloseTop(); }
				else if (G.machine === 'active') pause();
				e.preventDefault();
				return;
			}
			if (k === 'p' || k === 'P') {
				// P toggles the pause overlay from either side; other overlays keep priority
				if (G.machine === 'paused') { resume(); e.preventDefault(); return; }
				if (!UI.anyOverlayOpen() && G.session && !G.session.finished) { pause(); e.preventDefault(); }
				return;
			}
			if (UI.anyOverlayOpen()) return;
			if (!canAim()) {
				if (k === 'f' || k === 'F') RENDER.skipTrace(); // fast-forward to the exact end state
				return;
			}
			switch (k) {
				case 'ArrowLeft': G.aim.angle -= e.shiftKey ? 0.02 : 0.09; break;
				case 'ArrowRight': G.aim.angle += e.shiftKey ? 0.02 : 0.09; break;
				case 'ArrowUp': G.aim.power = Math.min(100, G.aim.power + (e.shiftKey ? 1 : 5)); UI.setPower(Math.round(G.aim.power)); break;
				case 'ArrowDown': G.aim.power = Math.max(1, G.aim.power - (e.shiftKey ? 1 : 5)); UI.setPower(Math.round(G.aim.power)); break;
				case ' ': case 'Enter': strike(); e.preventDefault(); return;
				case 'u': case 'U': doUndo(); return;
				case 'h': case 'H': doHint(); return;
				case 'c': case 'C': RENDER.loadCourse(currentCourse(), CONTENT.getTheme(currentCourse().theme)); RENDER.applySnapshot(G.session.state); updateAimView(); return;
				default: return;
			}
			AUDIO.event({ type: 'aim-tick' });
			updateAimView();
			e.preventDefault();
		});

		// gamepad: focus navigation + primary/secondary + pause, polled at low rate
		let padPrev = {};
		setInterval(() => {
			const pads = navigator.getGamepads ? navigator.getGamepads() : [];
			const gp = pads && pads[0];
			if (!gp) return;
			const pressed = (i) => gp.buttons[i] && gp.buttons[i].pressed;
			const edge = (name, v) => { const was = padPrev[name]; padPrev[name] = v; return v && !was; };
			if (edge('a', pressed(0))) { if (canAim()) strike(); }
			if (edge('b', pressed(1))) { if (UI.anyOverlayOpen()) emitCloseTop(); }
			if (edge('start', pressed(9))) { G.machine === 'paused' ? resume() : pause(); }
			if (canAim()) {
				const ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
				if (Math.abs(ax) > 0.25) { G.aim.angle += ax * 0.05; updateAimView(); }
				if (Math.abs(ay) > 0.25) {
					G.aim.power = Math.max(1, Math.min(100, G.aim.power + ay * 1.5));
					UI.setPower(Math.round(G.aim.power));
					updateAimView();
				}
			}
		}, 50);
	}

	function emitCloseTop() {
		const top = UI.topOverlay();
		if (top === 'overlay-pause') resume();
		else if (top === 'overlay-settings') { UI.closeOverlay(top); }
		else if (top === 'overlay-help') UI.closeOverlay(top);
		else if (top === 'overlay-results') { /* results require an explicit choice */ }
	}

	function canAim() {
		const sess = G.session;
		if (!sess || G.machine !== 'active') return false;
		const st = sess.state;
		return st.phase === 'aim' && !st.terminal && !isOpponent(st.players[st.currentPlayer].id);
	}

	function doUndo() {
		const sess = G.session;
		if (!sess || sess.mode !== 'practice') { UI.toast('Undo is only available in Practice'); return; }
		if (SESSION.undo(sess)) {
			AUDIO.event({ type: 'undo' });
			RENDER.currentState = sess.state;
			RENDER.applySnapshot(sess.state);
			defaultAim();
			refreshHud();
		} else UI.toast('Nothing to undo');
	}

	// Hints call the same legal-action API used by play.
	function doHint() {
		const sess = G.session;
		if (!sess) return;
		const legal = RULES.legalActions(sess.state);
		if (!legal.length) { UI.toast('No actions available right now'); return; }
		const c = currentCourse();
		const me = sess.state.players[sess.state.currentPlayer];
		G.aim.angle = Math.atan2(c.cup.y - me.ball.y, c.cup.x - me.ball.x);
		G.aim.power = Math.min(80, Math.max(25, Math.hypot(c.cup.x - me.ball.x, c.cup.y - me.ball.y) * 9));
		UI.setPower(Math.round(G.aim.power));
		updateAimView();
		UI.announce('Hint: aim ' + Math.round(G.aim.angle * 180 / Math.PI) + ' degrees at ' + Math.round(G.aim.power) + ' percent power.', false);
	}

	// ---------- title ----------

	function updateTitle() {
		const p = G.progress;
		const done = Object.keys(p.journey.stars).length;
		const el = document.getElementById('title-progress');
		el.textContent = 'Journey: ' + done + '/' + CONTENT.JOURNEY.length + ' stages • Holes completed: ' + p.mastery.holesCompleted +
			(p.mastery.bestDaily ? ' • Best daily: ' + p.mastery.bestDaily : '');
	}

	// ---------- lifecycle ----------

	function bindLifecycle() {
		document.addEventListener('visibilitychange', () => {
			const hidden = document.hidden;
			RENDER.setHidden(hidden);
			AUDIO.setBackgrounded(hidden);
			// Backgrounding pauses solo simulation (input locked); hosted clock is server-side.
			if (hidden && G.session && !G.hosted && G.machine === 'active') pause();
		});
		window.addEventListener('resize', onResize);
		window.addEventListener('orientationchange', () => setTimeout(onResize, 60));
	}

	function onResize() {
		const pf = document.getElementById('playfield');
		RENDER.resize(pf.clientWidth, pf.clientHeight);
	}

	function wireUi() {
		UI.on('menu', (m) => {
			AUDIO.resume();
			AUDIO.event({ type: 'ui' });
			if (m === 'play') openSetup('journey');
			else if (m === 'learn') {
				const next = CONTENT.TUTORIALS.find(t => !G.settings.tutorial.completed[t.id]) || CONTENT.TUTORIALS[0];
				startLearn(next.id);
			}
			else if (m === 'hosted') openLobby();
			else openSetup(m);
		});
		UI.on('setup-start', setupStart);
		UI.on('setup-back', () => { UI.showScreen('screen-title'); transition('title', 'setup-back'); });
		UI.on('lobby-leave', () => {
			if (G.hosted && G.hosted.rooms) G.hosted.client.leave();
			if (G.hosted && G.hosted.poll) clearTimeout(G.hosted.poll);
			G.hosted = null;
			G.lobbyRoster = null;
			UI.showScreen('screen-title');
			transition('title', 'lobby-leave');
		});
		UI.on('pause', pause);
		UI.on('resume', resume);
		UI.on('leave', leave);
		UI.on('restart-hole', () => {
			if (!G.session) return;
			UI.closeOverlay('overlay-pause');
			if (G.hosted) { UI.toast('Hosted matches cannot be restarted'); resume(); return; }
			const c = currentCourse();
			// the challenge must be carried over, or the retried round scores as an ordinary one
			startRound(G.mode, [c], {
				players: G.session.state.players.map(p => p.id),
				seed: G.session.seed,
				challenge: G.session.challenge,
			});
		});
		UI.on('settings', () => { UI.renderSettings(); UI.openOverlay('overlay-settings'); });
		UI.on('close-settings', () => UI.closeOverlay('overlay-settings'));
		UI.on('help', () => UI.openOverlay('overlay-help'));
		UI.on('close-help', () => UI.closeOverlay('overlay-help'));
		UI.on('strike', strike);
		UI.on('undo', doUndo);
		UI.on('hint', doHint);
		UI.on('power', (v) => { G.aim.power = v; updateAimView(); });
		UI.on('settings-changed', () => { applySettings(); PLATFORM.track('settings-change', { category: 'settings' }); });
		UI.on('results-next', () => { const n = nextAction(); UI.closeOverlay('overlay-results'); if (n.run) n.run(); });
		UI.on('results-retry', () => {
			if (!G.session) return;
			UI.closeOverlay('overlay-results');
			if (G.hosted) { leave(); return; }
			PLATFORM.track('retry', { mode: G.mode });
			const holes = G.session.holes;
			const ch = G.session.challenge;
			startRound(G.mode, holes, { players: G.session.state.players.map(p => p.id), challenge: ch, seed: G.session.seed });
		});
		UI.on('results-menu', leave);
	}

	// ---------- boot ----------

	async function boot() {
		transition('boot', 'load');
		PLATFORM.onIdentity = (id) => {
			UI.setAccount(id ? 'Playing as ' + id.name + ' — progress syncs to your account' : '');
		};
		PLATFORM.onSync = (s) => UI.setSync(syncLabel(s));
		G.settings = PLATFORM.loadSettings();
		G.progress = PLATFORM.loadProgress();
		UI.init(G.settings, G.progress);
		wireUi();
	window.PG.game = G; // inspectable state for smoke tests and support tooling

		const canvas = document.getElementById('game-canvas');
		try {
			RENDER.init(canvas, { tier: 'medium' });
		} catch (e) {
			UI.openOverlay('overlay-compat'); // clear compatibility message; settings preserved
			transition('title', 'webgl-unavailable');
			return;
		}
		RENDER.onFatal = () => UI.openOverlay('overlay-compat');
		RENDER.onEvent = (e) => AUDIO.event(e);
		AUDIO.onCaption(UI.caption); // settings toggle "Captions for sounds" feeds the caption chip

		applySettings();
		bindInput();
		bindLifecycle();
		onResize();
		await PLATFORM.syncTime(); // dev server provides /time; hosted play uses the local clock
		if (PLATFORM.state.hosted) {
			// remote wins on conflict: adopt the account's valid cloud save over the cache
			const adopted = await PLATFORM.loadAdoptedProgress(G.progress);
			if (adopted !== G.progress) {
				G.progress = adopted;
				UI.progress = G.progress;
			}
			PLATFORM.refreshIdentity();
		}
		updateTitle();
		transition('title', 'boot-complete');
		UI.showScreen('screen-title');
	}

	function syncLabel(s) {
		if (!PLATFORM.state.hosted) return '';
		return {
			synced: 'Cloud save: synced',
			saving: 'Cloud save: saving…',
			offline: 'Cloud save: offline — will retry',
			error: 'Cloud save: error — will retry',
		}[s] || '';
	}

	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { whenThree(boot); });
	else whenThree(boot);

	function whenThree(fn) {
		if (window.THREE) fn();
		else window.addEventListener('three-ready', fn, { once: true });
	}
})();
