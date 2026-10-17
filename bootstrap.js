'use strict';

// Pocket Greens — bootstrap: host handshake, capability detection, asset manifest, lifecycle.
// Owns the game-state machine:
// boot → title → mode-select → preparing → countdown → active ↔ paused → resolving → results → progression.
// Every transition happens here, with an explicit reason.

(function () {
	const PG = window.PG;
	const RULES = PG.rules, CONTENT = PG.content, SESSION = PG.session;
	const AUDIO = PG.audio, PLATFORM = PG.platform, RENDER = PG.render, UI = PG.ui, NET = PG.net;
	const I18N = PG.i18n;
	const T = I18N.t;
	// StarHermit account strings in the game language (read at use time).
	const PS = () => PG.platformI18n.platformStrings(PG.platformI18n.pickPlatformLocale(I18N.locale));
	// Rules rejection codes as player-facing text.
	const reasonText = (code) => T('reason.' + code) !== 'reason.' + code ? T('reason.' + code) : String(code || '');

	const G = {
		machine: 'boot',
		mode: null,
		session: null,
		aim: { angle: 0, power: 50, active: false },
		hint: null,
		learn: null,          // { tutorialId, step }
		hosted: null,         // realtime-room match state (signed in only)
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
		// set reduced motion / contrast first so the graphics pass sees them
		RENDER.setHighContrast(!!s.graphics.highContrast || s.graphics.palette !== 'default');
		RENDER.setReducedMotion(!!s.graphics.reducedMotion || matchMedia('(prefers-reduced-motion: reduce)').matches);
		// Graphics quality: Auto picks a preset from the detected GPU (gfx.js); applied live.
		G.quality = RENDER.setGraphics(s.graphics.gfx).preset;
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
	function nickFor(id) { return nickCache[id] || T('Player {id}', { id: String(id).slice(0, 8) }); }
	function primeNick(id) {
		if (!PLATFORM.state.hosted || !id || nickCache[id]) return;
		PLATFORM.nicknameFor(id).then(name => {
			nickCache[id] = name;
			refreshHud();
			renderRoomsLobby(G.lobbyRoster || []);
		}).catch(() => {});
	}
	function playerLabel(id) {
		if (isOpponent(id)) return (G.hosted && G.hosted.rooms) ? nickFor(id) : (G.hosted ? id : T('AI'));
		return T('You');
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
			? T(CONTENT.TUTORIALS.find(x => x.id === G.learn.tutorialId).title) + ' — ' + T(G.learn.stepText)
			: st.terminal ? T('Round complete')
			: st.phase === 'aim' ? (isOpponent(me.id) ? T('Opponent is aiming…') : T('Aim and strike'))
			: T('Ball rolling…');
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
			return '<p>' + T('{player}: <b>{n}</b> over {holes} hole(s)', { player: UI.escapeHtml(playerLabel(id)), n: tt.strokes + tt.penalties, holes: tt.holes }) + '</p>';
		}).join('');
		UI.setRails(
			'<p>' + modeLabel() + '</p><p>' + T('Seed: {seed}', { seed: '<code>' + UI.escapeHtml(sess.seed) + '</code>' }) + '</p>' + rows,
			st.phase === 'aim' && !isOpponent(me.id)
				? '<p>' + T('Drag back from the ball or use arrow keys. Power {n}%.', { n: Math.round(G.aim.power) }) + '</p>'
				: '<p>' + (isOpponent(me.id) ? T('Opponent turn') : T('Resolving…')) + '</p>');
		const canAct = st.phase === 'aim' && !isOpponent(me.id) && !st.terminal;
		UI.setControls({
			canStrike: canAct,
			canUndo: canAct && sess.mode === 'practice' && sess.undone.length > 0,
			canHint: canAct,
		});
	}

	function modeLabel() {
		const m = { learn: 'Learn', journey: 'Journey', daily: 'Daily Challenge', practice: 'Practice', challenge: 'Challenge', hosted: 'Hosted match' };
		return m[G.mode] ? T(m[G.mode]) : G.mode;
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
		// countdown keeps the "short path to play" explicit without blocking input long
		transition('countdown', 'round-ready');
		G.countdown = 2;
		UI.showScreen(null);
		const tut = holes[0].tutorial && CONTENT.TUTORIALS.find(x => x.id === holes[0].tutorial);
		UI.toast(tut ? T('Lesson: {title}', { title: T(tut.title) }) : T('{mode} — hole {n}', { mode: modeLabel(), n: 1 }));
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
		transition('resolving', 'strike');
		RENDER.setAim(null);
		const res = SESSION.applyCommand(sess, cmd);
		handleResult(res);
	}

	function handleResult(res) {
		const sess = G.session;
		if (res.error) {
			AUDIO.event({ type: 'invalid', reason: res.error });
			UI.announce(T('Invalid action: {reason}', { reason: reasonText(res.error) }), true);
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
		return T('Hole finished. {scores}.', { scores: parts.join(', ') });
	}

	function onNextHole(course) {
		const theme = CONTENT.getTheme(course.theme);
		RENDER.loadCourse(course, theme);
		AUDIO.stopAmbience();
		AUDIO.startAmbience(theme.ambience);
		UI.toast(T('Hole {n} — par {par}', { n: G.session.holeIndex + 1, par: course.par }));
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
		if (!sess.result || !sess.result.results.length) { UI.toast(T('Round ended unexpectedly')); leave(); return; }
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
		G.lastResults = { r, headline, total: mine.total, parTotal, unlocked };
		renderResultsOverlay();
		UI.openOverlay('overlay-results');
		UI.announce(T('{headline}. Total {total}.', { headline: T(headline), total: mine.total }), true);
		postVsPar(mine, parTotal);
	}

	// Results texts in the current language (also re-run on a language change).
	function renderResultsOverlay() {
		const lr = G.lastResults;
		if (!lr) return;
		UI.renderResults(lr.r, {
			headline: T('{headline} — {total} vs par {par}', { headline: T(lr.headline), total: lr.total, par: lr.parTotal }),
			unlocked: lr.unlocked.map(n => T(n)),
			nextLabel: nextAction().label,
			showNext: !!nextAction().label,
			playerLabel,
		});
		refreshVsParLine();
	}

	// Signed in, every finished solo round (Journey, Daily, Practice, Challenge —
	// not Learn or hosted tables) posts the player's strokes relative to par to the
	// platform `vs-par` board; the results overlay shows the rank line.
	function postVsPar(mine, parTotal) {
		const line = document.getElementById('results-lb');
		if (!line) return;
		if (!PLATFORM.state.hosted || G.mode === 'learn' || G.mode === 'hosted' || !(mine.holes > 0)) { line.hidden = true; G.vsPar = null; return; }
		const lb = G.vsPar = { state: 'posting' };
		refreshVsParLine();
		PLATFORM.postVsPar(mine.total - parTotal).then(r => {
			lb.state = !r.posted ? 'notPosted' : r.rank ? 'rank' : 'posted';
			lb.rank = r.rank;
			if (G.vsPar === lb) refreshVsParLine();
		});
	}

	function refreshVsParLine() {
		const line = document.getElementById('results-lb');
		const lb = G.vsPar;
		if (!line || !lb || line.hidden && lb.state !== 'posting' && !line.textContent) return;
		const s = PS();
		line.hidden = false;
		line.textContent = lb.state === 'posting' ? s.lbPosting : lb.state === 'notPosted' ? s.lbNotPosted
			: lb.state === 'rank' ? s.lbRank.replace('{rank}', lb.rank) : s.lbPosted;
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
		}
		PLATFORM.saveProgress(p);
		return unlocked;
	}

	function nextAction() {
		if (G.mode === 'journey' && G.session) {
			const idx = CONTENT.JOURNEY.indexOf(G.session.holes[0]);
			if (idx >= 0 && idx + 1 < CONTENT.JOURNEY.length) return { label: T('Next stage'), run: () => openSetup('journey', idx + 1) };
		}
		if (G.mode === 'learn' && G.learn) {
			const ti = CONTENT.TUTORIALS.findIndex(t => t.id === G.learn.tutorialId);
			const next = CONTENT.TUTORIALS[ti + 1];
			if (next) return { label: T('Next lesson'), run: () => startLearn(next.id) };
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
		UI.announce(T(tut.title) + '. ' + T(tut.steps[0].text), false);
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
			UI.toast(T(tut.steps[G.learn.step].text));
			UI.announce(T(tut.steps[G.learn.step].text), false);
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
					(i + 1) + '. ' + T('par {par}', { par: c.par }) + (best ? ' ★' + best : '') + (locked ? ' — ' + T('locked') : '') + '</option>';
			}).join('');
			UI.renderSetup({
				title: T('Journey'), desc: T('44 stages that introduce one concept at a time, then combine them. Mastery stages every chapter.'),
				duration: T('~2 minutes per stage'), players: '1', assists: T('Hints available'), ranked: false,
				extra: T('Unlocked: {n} / {total}', { n: unlocked, total: CONTENT.JOURNEY.length }),
				gridHtml: '<div class="setting-row"><label for="setup-stage">' + T('Stage') + '</label>' +
					'<select id="setup-stage" aria-label="' + UI.escapeHtml(T('Stages')) + '">' + options + '</select></div>',
			});
			const stageSel = document.getElementById('setup-stage');
			stageSel.addEventListener('change', () => {
				setupCtx.index = Number(stageSel.value);
				UI.toast(T('Stage {n} selected', { n: setupCtx.index + 1 }));
			});
		} else if (mode === 'daily') {
			UI.renderSetup({
				title: T('Daily Challenge'), desc: T('One shared seed and ruleset per UTC day. Everyone plays the same green.'),
				duration: T('~2 minutes'), players: '1',
				assists: PLATFORM.state.hosted ? T('No undo • best recorded to your account') : T('No undo'),
				ranked: false,
				extra: UI.escapeHtml(T('Seed: {seed} (local clock)', { seed: CONTENT.dailySeed() }) +
					(PLATFORM.state.hosted ? ' • ' + T('Platform boards are read-only') : '')),
			});
		} else if (mode === 'practice') {
			const grid = CONTENT.AUTHORED.map((c, i) =>
				'<button data-idx="' + i + '">' + c.id + ' ' + T('par {par}', { par: c.par }) + '</button>').join('');
			UI.renderSetup({
				title: T('Practice'), desc: T('Any hole, restart and undo freely, deterministic AI opponent optional. Never affects rating.'),
				duration: T('As long as you like'), players: T('1 (AI optional)'), assists: T('Undo + hints'), ranked: false,
				gridHtml: '<div class="setting-row"><label for="setup-ai">' + T('AI opponent') + '</label><input type="checkbox" id="setup-ai"></div>' +
					'<div class="grid" role="group" aria-label="' + UI.escapeHtml(T('Practice holes')) + '">' + grid + '</div>',
			});
			setupCtx.index = 0;
			document.querySelectorAll('#setup-body [data-idx]').forEach(b =>
				b.addEventListener('click', () => { setupCtx.index = Number(b.dataset.idx); }));
		} else if (mode === 'challenge') {
			const grid = CONTENT.CHALLENGES.map((ch, i) =>
				'<button data-idx="' + i + '"><b>' + UI.escapeHtml(T(ch.name)) + '</b><br><small>' + UI.escapeHtml(T(ch.desc)) + '</small></button>').join('');
			UI.renderSetup({
				title: T('Challenges'), desc: T('Constrained goals: move limits, speed targets, restricted power.'),
				duration: T('~1 minute each'), players: '1', assists: T('None'), ranked: false,
				gridHtml: '<div class="grid" role="group" aria-label="' + UI.escapeHtml(T('Challenges')) + '">' + grid + '</div>',
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

	// Hosted play uses StarHermit realtime rooms (host-routed over the realtime
	// WebSocket) and needs a launch token; without one the menu entry is hidden.
	function hostedPlayAvailable() { return PLATFORM.state.hosted && NET.supported(); }
	function openLobby() {
		if (hostedPlayAvailable()) openRoomsLobby();
	}

	function addPracticeFallback(body) {
		if (body.querySelector('button')) return;
		const b = document.createElement('button');
		b.className = 'primary';
		b.textContent = T('Practice vs AI');
		b.addEventListener('click', () => startRound('practice', [CONTENT.AUTHORED[0]], { players: ['you', 'ai'] }));
		body.appendChild(b);
	}

	// --- realtime rooms (hosted) ---

	async function openRoomsLobby() {
		transition('mode-select', 'menu-hosted');
		UI.showScreen('screen-lobby');
		const body = document.getElementById('lobby-body');
		body.innerHTML = '<p>' + T('Connecting…') + '</p>';
		const slug = PLATFORM.state.slug;
		let joined = await NET.quickJoin(PLATFORM, slug);
		let isHost = false;
		if (joined && !joined.ok) {
			if (termsRequired(joined)) { showOnlineStop('terms'); return; }
			body.innerHTML = '<p>' + UI.escapeHtml(T('Hosted play is unavailable right now ({error}).', { error: joined.error || 'error' })) + '</p>' +
				'<p>' + T('Practice against the deterministic AI instead — it is always available.') + '</p>';
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
				if (termsRequired(made)) { showOnlineStop('terms'); return; }
				body.innerHTML = '<p>' + UI.escapeHtml(T('Could not create a room ({error}).', { error: made.error || 'error' })) + '</p>';
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
		body.innerHTML = '<p>' + T('Room {id} — connecting…', { id: '<code>' + UI.escapeHtml(joined.roomId) + '</code>' }) + '</p>';
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
			'<li>' + UI.escapeHtml(nickFor(id)) + (id === h.myId ? ' ' + UI.escapeHtml(T('(you)')) : '') + '</li>').join('');
		let html = '<p>' + T('Room {id}', { id: '<code>' + UI.escapeHtml(h.roomId) + '</code>' }) + '</p><ul>' + names + '</ul>';
		if (ids.length < 2) html += '<p>' + T('Waiting for an opponent to join this room…') + '</p>';
		else if (h.isHost) html += '<p>' + T('Opponent found — start when ready.') + '</p>';
		else html += '<p>' + T('Opponent found — waiting for the host to start.') + '</p>';
		const body = document.getElementById('lobby-body');
		body.innerHTML = html;
		if (ids.length >= 2 && h.isHost) {
			const b = document.createElement('button');
			b.className = 'primary';
			b.textContent = T('Start match');
			b.addEventListener('click', () => hostStartMatch());
			body.appendChild(b);
		}
		addPracticeFallback(body);
	}

	function hostStartMatch() {
		const h = G.hosted;
		if (!h || !h.isHost || h.started) return;
		const ids = (G.lobbyRoster || []).slice(0, 2);
		if (ids.length < 2 || !h.myId) { UI.toast(T('Still waiting for an opponent')); return; }
		h.hostId = h.myId;
		h.players = [h.myId, ids.find(x => x !== h.myId) || ids[1]];
		h.course = CONTENT.dailyCourse();
		if (!h.client.send({ k: 'start', course: h.course, players: h.players, seed: CONTENT.dailySeed() })) {
			UI.toast(T('Could not reach the room'));
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
			if (!h.myId) { UI.toast(T('Could not confirm your seat — please rejoin')); h.client.leave(); return; }
			beginRoomsMatch();
			return;
		}
		if (msg.k === 'cmd' && h.isHost) { roomsHostCommand(msg); return; }
		if (msg.k === 'res') { roomsAdoptResult(msg); return; }
		if (msg.k === 'rej') {
			if (h.pending && h.pending[msg.id]) {
				delete h.pending[msg.id];
				AUDIO.event({ type: 'invalid', reason: msg.error });
				UI.announce(T('Rejected: {reason}', { reason: reasonText(msg.error) }), true);
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
				UI.announce(T('Rejected: {reason}', { reason: reasonText(out.error) }), true);
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
			UI.toast(T('Connection issue — move not sent'));
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

	// A dropped table is not reopened (by design: a mid-round drop ends online
	// play for that match). The SDK renewal tells why it dropped: pending terms
	// consent or a refused token → the player must reopen from StarHermit;
	// otherwise the table is gone → say so and offer solo play.
	function roomsOnClose() {
		const h = G.hosted;
		if (!h || !h.rooms || h.closing) return;
		if (!h.started) {
			G.hosted = null;
			G.lobbyRoster = null;
			const body = document.getElementById('lobby-body');
			if (body && !G.session) {
				body.innerHTML = '<p>' + T('The room connection was lost.') + '</p>';
				addPracticeFallback(body);
			}
			classifyDrop(false);
			return;
		}
		if (G.session && !G.session.state.terminal) {
			UI.toast(T('Connection to the match was lost'));
			if (h.pending) Object.keys(h.pending).forEach(k => delete h.pending[k]);
			if (G.machine === 'resolving') { transition('active', 'connection-lost'); refreshHud(); }
			classifyDrop(true);
		}
	}

	function classifyDrop(midMatch) {
		const sh = window.StarHermit;
		if (!sh || typeof sh.renewForReconnect !== 'function') { if (midMatch) showOnlineStop('unavailable'); return; }
		sh.renewForReconnect().then(r => {
			if (r === 'terms-required') showOnlineStop('terms');
			else if (r === 'relaunch') showOnlineStop('expired');
			else if (midMatch) showOnlineStop('unavailable');
		}).catch(() => { if (midMatch) showOnlineStop('unavailable'); });
	}

	function termsRequired(res) {
		return !!(res && (res.status === 403 || res.status === 451) &&
			((res.body && res.body.error === 'terms_acceptance_required') || /terms/i.test(res.error || '')));
	}

	// Visible stop for online play: the lobby card (when open), the status rail
	// notice and a toast. Terms / expired offer "Back to StarHermit" (relaunch).
	function showOnlineStop(kind) {
		G.onlineStop = kind;
		renderOnlineStop();
		// the open lobby card already shows the message; elsewhere a toast too
		const lobby = document.getElementById('screen-lobby');
		if (!(lobby && lobby.classList.contains('open'))) UI.toast(onlineStopText(kind));
	}
	function onlineStopText(kind) {
		return kind === 'terms' ? T('Accept the updated StarHermit terms to keep playing online — reopen the game from StarHermit.')
			: kind === 'expired' ? T('Your StarHermit session expired — reopen the game from StarHermit to play online.')
			: T('This table is no longer available — leave the round to play solo or start a new match.');
	}
	function renderOnlineStop() {
		const kind = G.onlineStop;
		const notice = document.getElementById('online-notice');
		if (!kind) { if (notice) notice.hidden = true; return; }
		const fill = (el) => {
			el.innerHTML = '<p>' + UI.escapeHtml(onlineStopText(kind)) + '</p>';
			if (kind !== 'unavailable' && window.StarHermit && typeof window.StarHermit.relaunch === 'function') {
				const b = document.createElement('button');
				b.className = 'primary';
				b.textContent = T('Back to StarHermit');
				b.addEventListener('click', () => window.StarHermit.relaunch());
				el.appendChild(b);
			}
		};
		if (notice) { fill(notice); notice.hidden = !(G.session && G.mode === 'hosted'); }
		const lobby = document.getElementById('screen-lobby');
		if (lobby && lobby.classList.contains('open') && !G.session) {
			const body = document.getElementById('lobby-body');
			fill(body);
			addPracticeFallback(body);
		}
	}

	function enterHosted() {
		const h = G.hosted;
		if (!h) return;
		h.course = h.course && h.course.course ? h.course.course : h.course;
		startRound('hosted', [h.course], { players: (h.players && h.players.length) ? h.players : [h.playerId], seed: h.roomId });
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
		clearTimeout(G.countdownTimer);
		clearTimeout(G.opponentTimer);
		G.hosted = null;
		G.lobbyRoster = null;
		G.session = null;
		RENDER.setPaused(false);
		G.learn = null;
		AUDIO.stopAmbience();
		// the HUD belongs to a round: reset it so no stale score or live Pause button remains
		RENDER.setAim(null);
		UI.setHud({ objective: 'Pocket Greens', hole: '–', par: '–', strokes: 0, total: 0, playing: false });
		UI.setControls({ canStrike: false, canUndo: false, canHint: false });
		UI.setRails(T('Choose a mode to begin.'), '');
		G.lastResults = null;
		G.vsPar = null;
		if (G.onlineStop === 'unavailable') G.onlineStop = null;
		renderOnlineStop();
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
			const k = actionFor(e.code);
			if (k === 'cancel' || (e.code === 'Escape' && !k)) {
				// Esc during a pull-back abandons the stroke (as Help documents) before it pauses
				if (drag) { drag = null; defaultAim(); refreshHud(); }
				else if (UI.anyOverlayOpen()) { emitCloseTop(); }
				else if (G.machine === 'active') pause();
				e.preventDefault();
				return;
			}
			if (k === 'pause') {
				// P toggles the pause overlay from either side; other overlays keep priority
				if (G.machine === 'paused') { resume(); e.preventDefault(); return; }
				if (!UI.anyOverlayOpen() && G.session && !G.session.finished) { pause(); e.preventDefault(); }
				return;
			}
			if (UI.anyOverlayOpen()) return;
			if (!canAim()) {
				if (k === 'fast_forward') RENDER.skipTrace(); // fast-forward to the exact end state
				return;
			}
			switch (k) {
				case 'aim_left': G.aim.angle -= e.shiftKey ? 0.02 : 0.09; break;
				case 'aim_right': G.aim.angle += e.shiftKey ? 0.02 : 0.09; break;
				case 'power_up': G.aim.power = Math.min(100, G.aim.power + (e.shiftKey ? 1 : 5)); UI.setPower(Math.round(G.aim.power)); break;
				case 'power_down': G.aim.power = Math.max(1, G.aim.power - (e.shiftKey ? 1 : 5)); UI.setPower(Math.round(G.aim.power)); break;
				case 'strike': strike(); e.preventDefault(); return;
				case 'undo': doUndo(); return;
				case 'hint': doHint(); return;
				case 'camera': RENDER.loadCourse(currentCourse(), CONTENT.getTheme(currentCourse().theme)); RENDER.applySnapshot(G.session.state); updateAimView(); return;
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
		if (!sess || sess.mode !== 'practice') { UI.toast(T('Undo is only available in Practice')); return; }
		if (SESSION.undo(sess)) {
			AUDIO.event({ type: 'undo' });
			RENDER.currentState = sess.state;
			RENDER.applySnapshot(sess.state);
			defaultAim();
			refreshHud();
		} else UI.toast(T('Nothing to undo'));
	}

	// Hints call the same legal-action API used by play.
	function doHint() {
		const sess = G.session;
		if (!sess) return;
		const legal = RULES.legalActions(sess.state);
		if (!legal.length) { UI.toast(T('No actions available right now')); return; }
		const c = currentCourse();
		const me = sess.state.players[sess.state.currentPlayer];
		G.aim.angle = Math.atan2(c.cup.y - me.ball.y, c.cup.x - me.ball.x);
		G.aim.power = Math.min(80, Math.max(25, Math.hypot(c.cup.x - me.ball.x, c.cup.y - me.ball.y) * 9));
		UI.setPower(Math.round(G.aim.power));
		updateAimView();
		UI.announce(T('Hint: aim {deg} degrees at {power} percent power.', { deg: Math.round(G.aim.angle * 180 / Math.PI), power: Math.round(G.aim.power) }), false);
	}

	// ---------- title ----------

	function updateTitle() {
		const p = G.progress;
		const done = Object.keys(p.journey.stars).length;
		const el = document.getElementById('title-progress');
		el.textContent = T('Journey: {done}/{total} stages • Holes completed: {holes}', { done, total: CONTENT.JOURNEY.length, holes: p.mastery.holesCompleted }) +
			(p.mastery.bestDaily ? ' • ' + T('Best daily: {n}', { n: p.mastery.bestDaily }) : '');
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
		UI.on('setup-back', () => { setupCtx = null; UI.showScreen('screen-title'); transition('title', 'setup-back'); });
		UI.on('lobby-leave', () => {
			if (G.hosted && G.hosted.rooms) G.hosted.client.leave();
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
			if (G.hosted) { UI.toast(T('Hosted matches cannot be restarted')); resume(); return; }
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
		UI.on('settings-changed', applySettings);
		UI.on('results-next', () => { const n = nextAction(); UI.closeOverlay('overlay-results'); if (n.run) n.run(); });
		UI.on('results-retry', () => {
			if (!G.session) return;
			UI.closeOverlay('overlay-results');
			if (G.hosted) { leave(); return; }
			const holes = G.session.holes;
			const ch = G.session.challenge;
			startRound(G.mode, holes, { players: G.session.state.players.map(p => p.id), challenge: ch, seed: G.session.seed });
		});
		UI.on('results-menu', leave);
	}

	// ---------- keyboard bindings ----------

	// Declared as control.* in starhermit.txt; the player's StarHermit overrides
	// replace these defaults when signed in. Shift (fine aim) is a modifier.
	const DEFAULT_BINDINGS = {
		aim_left: ['ArrowLeft'],
		aim_right: ['ArrowRight'],
		power_up: ['ArrowUp'],
		power_down: ['ArrowDown'],
		strike: ['Space', 'Enter', 'NumpadEnter'],
		cancel: ['Escape'],
		pause: ['KeyP'],
		undo: ['KeyU'],
		hint: ['KeyH'],
		camera: ['KeyC'],
		fast_forward: ['KeyF'],
	};
	let bindings = JSON.parse(JSON.stringify(DEFAULT_BINDINGS));
	function actionFor(code) {
		for (const a in bindings) if (bindings[a].indexOf(code) >= 0) return a;
		return null;
	}

	// ---------- StarHermit account ----------

	function refreshAccountButtons() {
		UI.setAccountButtons({ signIn: PLATFORM.canSignIn(), invite: !!PLATFORM.inviteLink() });
		document.getElementById('m-hosted').hidden = !hostedPlayAvailable();
	}

	function wireAccount() {
		const signIn = document.getElementById('m-signin');
		const invite = document.getElementById('m-invite');
		const label = () => { signIn.textContent = PS().signIn; invite.textContent = PS().invite; };
		label();
		I18N.onChange(label);
		signIn.addEventListener('click', () => PLATFORM.signIn());
		invite.addEventListener('click', async () => {
			const link = PLATFORM.inviteLink();
			if (!link) return;
			try {
				await navigator.clipboard.writeText(link);
				UI.toast(PS().inviteCopied);
			} catch (e) {
				UI.toast(PS().inviteFailed.replace('{link}', link));
			}
		});
		PLATFORM.onAuth = ({ signedIn }) => {
			if (!signedIn) UI.toast(PS().signedOut);
			refreshAccountButtons();
		};
		// Renewal hit pending terms consent (any time, e.g. the background refresh).
		PLATFORM.onTermsRequired = () => showOnlineStop('terms');
		// Another device saved first: the platform reloaded and merged; adopt it.
		PLATFORM.onProgressMerged = (merged) => {
			G.progress = merged;
			UI.progress = merged;
			if (G.machine === 'title') updateTitle();
		};
		refreshAccountButtons();
	}

	// ---------- live language switching ----------
	// Static markup is re-applied by i18n.js; everything built in code re-renders
	// here in place. Rounds, sockets and timers are not touched.
	function wireLanguage() {
		I18N.onChange(() => {
			updateTitle();
			UI.renderControlsHelp(bindings);
			UI.setSync(syncLabel(PLATFORM.state.sync));
			if (PLATFORM.state.hosted && PLATFORM.state.nickname) UI.setAccount(T('Playing as {name} — progress syncs to your account', { name: PLATFORM.state.nickname }));
			if (UI.anyOverlayOpen() && document.getElementById('overlay-settings').classList.contains('open')) UI.relabelSettings();
			if (setupCtx && document.getElementById('screen-setup').classList.contains('open')) {
				const keep = setupCtx.index, ai = document.getElementById('setup-ai') && document.getElementById('setup-ai').checked;
				openSetup(setupCtx.mode, setupCtx.mode === 'journey' ? keep : setupCtx.preset);
				setupCtx.index = keep;
				if (document.getElementById('setup-ai')) document.getElementById('setup-ai').checked = !!ai;
			}
			if (G.hosted && G.hosted.rooms && !G.hosted.started && G.lobbyRoster) renderRoomsLobby(G.lobbyRoster);
			if (G.lastResults && document.getElementById('overlay-results').classList.contains('open')) renderResultsOverlay();
			renderOnlineStop();
			if (G.session) refreshHud();
			else UI.setRails(T('Choose a mode to begin.'), '');
		});
	}

	// ---------- boot ----------

	async function boot() {
		transition('boot', 'load');
		PLATFORM.onIdentity = (id) => {
			UI.setAccount(id ? T('Playing as {name} — progress syncs to your account', { name: id.name }) : '');
		};
		PLATFORM.onSync = (s) => UI.setSync(syncLabel(s));
		G.settings = PLATFORM.loadSettings();
		// graphics settings: migrate the legacy single "quality tier" onto a preset
		if (!G.settings.graphics.gfx || typeof G.settings.graphics.gfx !== 'object') {
			G.settings.graphics.gfx = { preset: PG.gfx.fromLegacyTier(G.settings.graphics.tier) };
		}
		G.progress = PLATFORM.loadProgress();
		UI.init(G.settings, G.progress, bindings);
		wireUi();
		wireAccount();
		wireLanguage();
	window.PG.game = G; // inspectable state for smoke tests and support tooling

		const canvas = document.getElementById('game-canvas');
		try {
			RENDER.init(canvas, { gfx: G.settings.graphics.gfx });
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
		if (PLATFORM.state.hosted) {
			// merge the account's valid cloud save with this device's progress (best of both)
			const adopted = await PLATFORM.loadAdoptedProgress(G.progress);
			if (adopted !== G.progress) {
				G.progress = adopted;
				UI.progress = G.progress;
			}
			PLATFORM.refreshIdentity();
			// platform settings KV wins over the local cache for known preference keys
			const remote = await PLATFORM.loadRemoteSettings(G.settings);
			Object.assign(G.settings, remote);
			UI.settings = G.settings;
			applySettings();
		}
		PLATFORM.loadBindings(DEFAULT_BINDINGS).then((b) => { bindings = b; UI.renderControlsHelp(b); });
		updateTitle();
		showTitleBackdrop();
		transition('title', 'boot-complete');
		UI.showScreen('screen-title');
	}

	// The title menu sits over a live garden hole (decorative; no session, no input).
	function showTitleBackdrop() {
		if (RENDER.course) return;
		const course = CONTENT.AUTHORED[8] || CONTENT.AUTHORED[0];
		try { RENDER.loadCourse(course, CONTENT.getTheme(course.theme)); } catch (e) { /* backdrop is optional */ }
	}

	function syncLabel(s) {
		if (!PLATFORM.state.hosted) return '';
		const key = {
			synced: 'Cloud save: synced',
			saving: 'Cloud save: saving…',
			offline: 'Cloud save: offline — will retry',
			error: 'Cloud save: error — will retry',
		}[s];
		return key ? T(key) : '';
	}

	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { whenThree(boot); });
	else whenThree(boot);

	function whenThree(fn) {
		if (window.THREE) fn();
		else window.addEventListener('three-ready', fn, { once: true });
	}
})();
