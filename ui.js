'use strict';

// Pocket Greens — ui: responsive DOM shell, focus, settings, overlays, accessibility mirror.
// UI state is fully separate from simulation state; closing a drawer can never affect a match.

(function () {
	const PG = window.PG;
	const $ = (id) => document.getElementById(id);

	const SCREENS = ['screen-title', 'screen-setup', 'screen-lobby'];
	const OVERLAYS = ['overlay-pause', 'overlay-settings', 'overlay-results', 'overlay-help', 'overlay-compat'];

	const ui = {
		handlers: {},          // event name -> fn (set by bootstrap)
		lastFocus: null,       // focus restoration for every modal
		settings: null,        // platform settings object
		progress: null,
		pendingOverlay: null,
	};

	function on(name, fn) { ui.handlers[name] = fn; }
	function emit(name, arg) { if (ui.handlers[name]) ui.handlers[name](arg); }

	// ---------- screens & overlays ----------

	// Controls that sit behind a full-screen menu are covered visually but would still be
	// reachable with Tab; take them out of the tab order while a screen is showing.
	const BACKDROP = ['rail-left', 'rail-right', 'action-tray'];
	function setBackdropInert(inert) {
		for (const id of BACKDROP) {
			const el = $(id);
			if (!el) continue;
			el.inert = inert;
			if (inert) el.setAttribute('aria-hidden', 'true'); else el.removeAttribute('aria-hidden');
		}
	}

	function showScreen(id) {
		for (const s of SCREENS) $(s).classList.toggle('open', s === id);
		setBackdropInert(!!id);
		if (id) {
			const first = $(id).querySelector('button.primary, button');
			if (first) first.focus();
		}
		emit('screen', id);
	}

	const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

	function openOverlay(id) {
		// only remember the pre-modal focus for the first modal in a stack
		if (!anyOverlayOpen()) ui.lastFocus = document.activeElement;
		$(id).classList.add('open');
		const first = $(id).querySelector('button.primary, button');
		if (first) first.focus();
	}

	function closeOverlay(id) {
		$(id).classList.remove('open');
		if (anyOverlayOpen()) {
			const next = $(topOverlay()).querySelector('button.primary, button');
			if (next) next.focus();
			return;
		}
		if (ui.lastFocus && document.contains(ui.lastFocus) && !ui.lastFocus.disabled) ui.lastFocus.focus();
		ui.lastFocus = null;
	}

	// aria-modal only promises modality; Tab still has to be confined by hand.
	function trapFocus(e) {
		if (e.key !== 'Tab') return;
		const top = topOverlay();
		if (!top) return;
		const items = Array.from($(top).querySelectorAll(FOCUSABLE)).filter(el => el.offsetParent !== null);
		if (!items.length) return;
		const first = items[0], last = items[items.length - 1];
		if (!$(top).contains(document.activeElement)) { e.preventDefault(); first.focus(); return; }
		if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
		else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
	}

	function anyOverlayOpen() { return OVERLAYS.some(o => $(o).classList.contains('open')); }
	function topOverlay() { return OVERLAYS.filter(o => $(o).classList.contains('open')).pop() || null; }

	// ---------- announcements, captions, toast ----------

	let toastTimer = null;
	function toast(text) {
		const t = $('toast');
		t.textContent = text;
		t.classList.add('show');
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
	}

	function announce(text, urgent) {
		$(urgent ? 'live-urgent' : 'live').textContent = '';
		// re-set after a tick so screen readers re-announce repeated text
		setTimeout(() => { $(urgent ? 'live-urgent' : 'live').textContent = text; }, 30);
	}

	let captionTimer = null;
	function caption(text) {
		if (!ui.settings || !ui.settings.audio.captions) return;
		const c = $('captions');
		c.textContent = text;
		c.classList.add('show');
		clearTimeout(captionTimer);
		captionTimer = setTimeout(() => c.classList.remove('show'), 2400);
	}

	// ---------- HUD ----------

	function setHud(o) {
		if (o.objective != null) $('objective').textContent = o.objective;
		if (o.hole != null) $('stat-hole').textContent = o.hole;
		if (o.par != null) $('stat-par').textContent = o.par;
		if (o.strokes != null) $('stat-strokes').textContent = o.strokes;
		if (o.total != null) $('stat-total').textContent = o.total;
		if (o.playing != null) $('btn-pause').disabled = !o.playing;
	}

	function setRails(progressHtml, statusHtml) {
		$('rail-progress').innerHTML = progressHtml;
		$('rail-status').innerHTML = statusHtml;
	}

	function setPower(v) {
		$('power').value = v;
		$('power-val').textContent = v;
	}
	function getPower() { return Number($('power').value); }

	// account + cloud-sync line (hosted mode only; both stay empty otherwise)
	function setAccount(text) {
		const el = $('title-account');
		if (!el) return;
		el.textContent = text || '';
		el.style.display = text ? '' : 'none';
	}
	function setSync(text) {
		const el = $('sync-status');
		if (el) el.textContent = text || '';
	}

	function setControls(o) {
		$('btn-strike').disabled = !o.canStrike;
		$('btn-undo').disabled = !o.canUndo;
		$('btn-hint').disabled = !o.canHint;
	}

	// ---------- settings ----------

	function settingRow(label, inputHtml) {
		return '<div class="setting-row"><label>' + label + '</label>' + inputHtml + '</div>';
	}

	function renderSettings() {
		const s = ui.settings;
		const body = $('settings-body');
		body.innerHTML =
			'<h3>Audio</h3>' +
			settingRow('Music', '<input type="range" min="0" max="1" step="0.05" value="' + s.audio.music + '" data-set="audio.music">') +
			settingRow('Effects', '<input type="range" min="0" max="1" step="0.05" value="' + s.audio.effects + '" data-set="audio.effects">') +
			settingRow('Ambience', '<input type="range" min="0" max="1" step="0.05" value="' + s.audio.ambience + '" data-set="audio.ambience">') +
			settingRow('Voice', '<input type="range" min="0" max="1" step="0.05" value="' + s.audio.voice + '" data-set="audio.voice">') +
			settingRow('Mute all', '<input type="checkbox" ' + (s.audio.muted ? 'checked' : '') + ' data-set="audio.muted">') +
			settingRow('Captions for sounds', '<input type="checkbox" ' + (s.audio.captions ? 'checked' : '') + ' data-set="audio.captions">') +
			'<h3 id="gfx-h">' + escapeHtml(gfxStrings().graphics) + '</h3>' +
			'<div id="gfx-section" role="group" aria-labelledby="gfx-h"></div>' +
			settingRow('Reduced motion', '<input type="checkbox" ' + (s.graphics.reducedMotion ? 'checked' : '') + ' data-set="graphics.reducedMotion">') +
			settingRow('High contrast', '<input type="checkbox" ' + (s.graphics.highContrast ? 'checked' : '') + ' data-set="graphics.highContrast">') +
			settingRow('Larger text', '<input type="checkbox" ' + (s.graphics.largeText ? 'checked' : '') + ' data-set="graphics.largeText">') +
			settingRow('Color-vision palette', '<select data-set="graphics.palette">' +
				['default', 'deuteranopia', 'protanopia', 'tritanopia'].map(t => '<option ' + (s.graphics.palette === t ? 'selected' : '') + '>' + t + '</option>').join('') + '</select>') +
			'<h3>Controls</h3>' +
			settingRow('Left-handed controls', '<input type="checkbox" ' + (s.controls.leftHanded ? 'checked' : '') + ' data-set="controls.leftHanded">') +
			settingRow('Hold-to-aim (vs toggle)', '<input type="checkbox" ' + (s.controls.holdToAim ? 'checked' : '') + ' data-set="controls.holdToAim">') +
			settingRow('Timing assistance', '<input type="checkbox" ' + (s.controls.timingAssist ? 'checked' : '') + ' data-set="controls.timingAssist">') +
			settingRow('Haptics', '<input type="checkbox" ' + (s.controls.haptics ? 'checked' : '') + ' data-set="controls.haptics">') +
			settingRow('Replay tutorials', '<button data-action="replay-tutorials">Reset lessons</button>');
		body.querySelectorAll('[data-set]').forEach(el => {
			el.addEventListener('change', () => {
				const path = el.dataset.set.split('.');
				let node = ui.settings;
				for (let i = 0; i < path.length - 1; i++) node = node[path[i]];
				node[path[path.length - 1]] = el.type === 'checkbox' ? el.checked : (el.type === 'range' ? Number(el.value) : el.value);
				emit('settings-changed', ui.settings);
			});
		});
		renderGraphics();
		body.querySelector('[data-action="replay-tutorials"]').addEventListener('click', () => {
			ui.settings.tutorial.completed = {};
			emit('settings-changed', ui.settings);
			toast('Lessons reset');
		});
	}

	// ---------- graphics (quality presets, per-effect overrides, render scale) ----------

	function gfxStrings() { return PG.gfxI18n.strings(); }
	function gfxSaved() {
		const g = ui.settings.graphics;
		if (!g.gfx || typeof g.gfx !== 'object') g.gfx = { preset: 'auto' };
		return g.gfx;
	}

	function gfxRow(id, label, inputHtml) {
		return '<div class="setting-row"><label for="' + id + '">' + escapeHtml(label) + '</label>' + inputHtml + '</div>';
	}

	function renderGraphics() {
		const box = $('gfx-section');
		if (!box) return;
		const GFX = PG.gfx, T = gfxStrings();
		const saved = gfxSaved();
		const info = PG.render.graphicsInfo(T.sum);
		const detected = info.detected;
		const presetName = (p) => T[p] || p;
		const cur = GFX.PRESETS.includes(saved.preset) ? saved.preset : 'auto';
		const effective = info.resolved.preset;
		let html = gfxRow('gfx-preset', T.quality,
			'<select id="gfx-preset" data-gfx="preset">' +
			['auto'].concat(GFX.PRESETS).map(p => '<option value="' + p + '"' + (cur === p ? ' selected' : '') + '>' +
				escapeHtml(p === 'auto' ? T.auto.replace('{tier}', presetName(detected)) : presetName(p)) + '</option>').join('') +
			'</select>');
		const pct = Math.round((Number(saved.render_scale) || 1) * 100);
		html += gfxRow('gfx-scale', T.renderScale,
			'<span class="scale-wrap"><input type="range" id="gfx-scale" data-gfx="render_scale" min="50" max="200" step="5" value="' + pct + '">' +
			'<output id="gfx-scale-val" for="gfx-scale">' + pct + '%</output></span>');
		html += '<div id="gfx-overrides">';
		for (const cat of Object.keys(GFX.CATEGORIES)) {
			const own = GFX.presetTier(effective, cat);
			const val = GFX.CATEGORIES[cat].includes(saved[cat]) ? saved[cat] : 'preset';
			html += gfxRow('gfx-' + cat, T.cat[cat],
				'<select id="gfx-' + cat + '" data-gfx="' + cat + '">' +
				'<option value="preset"' + (val === 'preset' ? ' selected' : '') + '>' + escapeHtml(T.fromPreset.replace('{tier}', T.tier[own] || own)) + '</option>' +
				GFX.CATEGORIES[cat].map(tier => '<option value="' + tier + '"' + (val === tier ? ' selected' : '') + '>' + escapeHtml(T.tier[tier] || tier) + '</option>').join('') +
				'</select>');
		}
		html += '</div>';
		html += gfxRow('gfx-adaptive', T.adaptive, '<input type="checkbox" id="gfx-adaptive" data-gfx="adaptive"' + (saved.adaptive !== false ? ' checked' : '') + '>');
		html += gfxRow('gfx-fps', T.showFps, '<input type="checkbox" id="gfx-fps" data-gfx="show_fps"' + (saved.show_fps ? ' checked' : '') + '>');
		html += '<p id="gfx-summary" aria-live="polite"></p><p id="gfx-post-note" hidden>' + escapeHtml(T.postUnavailable) + '</p>';
		box.innerHTML = html;

		box.querySelectorAll('[data-gfx]').forEach(el => {
			if (el.type === 'range') el.addEventListener('input', () => { $('gfx-scale-val').textContent = el.value + '%'; });
			el.addEventListener('change', () => {
				const k = el.dataset.gfx;
				let next = Object.assign({}, gfxSaved());
				if (k === 'preset') next = GFX.choosePreset(next, el.value); // a preset clears overrides
				else if (k === 'render_scale') next.render_scale = Math.min(2, Math.max(0.5, Number(el.value) / 100));
				else if (k === 'adaptive') next.adaptive = el.checked;
				else if (k === 'show_fps') next.show_fps = el.checked;
				else if (el.value === 'preset') delete next[k];
				else next[k] = el.value;
				ui.settings.graphics.gfx = next;
				emit('settings-changed', ui.settings);
				if (k === 'preset') {
					renderGraphics();
					const sel = $('gfx-preset');
					if (sel) sel.focus();
				} else updateGraphicsSummary();
			});
		});
		updateGraphicsSummary();
	}

	// "GPU · cost summary · W×H px", plus the post-processing note when it could not be built
	function updateGraphicsSummary() {
		const el = $('gfx-summary');
		if (!el || !PG.render.ready) return;
		const T = gfxStrings();
		const info = PG.render.graphicsInfo(T.sum);
		let text = (info.gpu || T.unknownGpu) + ' · ' + info.summary;
		if (info.resolved.showFps && info.fps) text += ' · ' + info.fps + ' fps';
		if (el.textContent !== text) el.textContent = text;
		const note = $('gfx-post-note');
		if (note) note.hidden = !info.postFailed;
		document.body.dataset.gfxPreset = info.resolved.preset;
		document.body.dataset.gfxAuto = info.resolved.auto ? '1' : '0';
	}
	setInterval(() => { if ($('overlay-settings') && $('overlay-settings').classList.contains('open')) updateGraphicsSummary(); }, 1000);

	function applySettingsToDom() {
		const s = ui.settings;
		document.body.classList.toggle('high-contrast', !!s.graphics.highContrast);
		document.body.classList.toggle('large-text', !!s.graphics.largeText);
		updateGraphicsSummary();
	}

	// ---------- help (rule cards generated from current control mappings) ----------

	function renderHelp(bindings) {
		$('help-body').innerHTML =
			'<p><strong>Goal:</strong> hole out in the fewest strokes. Water adds a penalty stroke and returns the ball. Holes are capped at double par plus one.</p>' +
			'<h3>Controls</h3><ul>' +
			bindings.map(b => '<li><strong>' + b.action + ':</strong> ' + b.keys + '</li>').join('') + '</ul>' +
			'<h3>Hazards</h3><ul>' +
			'<li><strong>Water</strong> (blue): +1 penalty stroke, ball returns to where you struck.</li>' +
			'<li><strong>Sand</strong> (pale): heavy friction — play firm or around.</li>' +
			'<li><strong>Walls & obstacles</strong>: the ball banks off them; use them.</li>' +
			'<li><strong>Keepers</strong> (moving): time your stroke past their patrol.</li>' +
			'</ul><p>Fast balls can lip out of the cup — arrive softly.</p>';
	}

	// ---------- results ----------

	function renderResults(result, opts) {
		opts = opts || {};
		const rows = result.results.map((r, i) =>
			'<tr><td>' + (i + 1) + '</td><td>' + escapeHtml(r.id) + '</td><td>' + r.strokes + '</td><td>' +
			r.penalties + '</td><td><b>' + r.total + '</b></td></tr>').join('');
		let html = '<p><strong>' + escapeHtml(opts.headline || 'Round complete') + '</strong></p>' +
			'<table style="width:100%;border-collapse:collapse" summary="Score breakdown">' +
			'<thead><tr><th>#</th><th>Player</th><th>Strokes</th><th>Penalties</th><th>Total</th></tr></thead>' +
			'<tbody>' + rows + '</tbody></table>';
		if (result.challenge) {
			html += '<p>Challenge ' + escapeHtml(result.challenge.id) + ': <b>' +
				(result.challenge.status === 'passed' ? 'passed' : 'not met — ' + result.challenge.status.replace('failed:', '').replace(/-/g, ' ')) + '</b></p>';
		}
		if (opts.unlocked && opts.unlocked.length) {
			html += '<p>New achievement' + (opts.unlocked.length > 1 ? 's' : '') + ': <b>' + opts.unlocked.map(escapeHtml).join(', ') + '</b></p>';
		}
		if (opts.nextLabel) $('r-next').textContent = opts.nextLabel; else $('r-next').textContent = 'Next';
		$('r-next').style.display = opts.showNext === false ? 'none' : '';
		$('results-body').innerHTML = html;
	}

	function escapeHtml(s) {
		return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
	}

	// ---------- mode setup & journey grid ----------

	function renderSetup(o) {
		$('setup-h').textContent = o.title;
		let html = '<p>' + escapeHtml(o.desc) + '</p>' +
			'<ul>' +
			'<li>Duration: ' + escapeHtml(o.duration) + '</li>' +
			'<li>Players: ' + escapeHtml(o.players) + '</li>' +
			'<li>Assists: ' + escapeHtml(o.assists) + '</li>' +
			'<li>' + (o.ranked ? '<b>Ranked result</b>' : 'Unranked — does not affect rating') + '</li>' +
			(o.extra ? '<li>' + o.extra + '</li>' : '') +
			'</ul>';
		if (o.gridHtml) html += o.gridHtml;
		$('setup-body').innerHTML = html;
	}

	// ---------- wiring ----------

	function bind() {
		$('m-play').addEventListener('click', () => emit('menu', 'play'));
		$('m-learn').addEventListener('click', () => emit('menu', 'learn'));
		$('m-journey').addEventListener('click', () => emit('menu', 'journey'));
		$('m-daily').addEventListener('click', () => emit('menu', 'daily'));
		$('m-practice').addEventListener('click', () => emit('menu', 'practice'));
		$('m-challenge').addEventListener('click', () => emit('menu', 'challenge'));
		$('m-hosted').addEventListener('click', () => emit('menu', 'hosted'));
		$('setup-start').addEventListener('click', () => emit('setup-start'));
		$('setup-back').addEventListener('click', () => emit('setup-back'));
		$('lobby-back').addEventListener('click', () => emit('lobby-leave'));
		$('btn-pause').addEventListener('click', () => emit('pause'));
		$('btn-help').addEventListener('click', () => emit('help'));
		$('btn-settings').addEventListener('click', () => emit('settings'));
		$('p-resume').addEventListener('click', () => emit('resume'));
		$('p-settings').addEventListener('click', () => emit('settings'));
		$('p-help').addEventListener('click', () => emit('help'));
		$('p-restart').addEventListener('click', () => emit('restart-hole'));
		$('p-leave').addEventListener('click', () => emit('leave'));
		$('settings-close').addEventListener('click', () => emit('close-settings'));
		$('help-close').addEventListener('click', () => emit('close-help'));
		$('r-next').addEventListener('click', () => emit('results-next'));
		$('r-retry').addEventListener('click', () => emit('results-retry'));
		$('r-menu').addEventListener('click', () => emit('results-menu'));
		$('btn-strike').addEventListener('click', () => emit('strike'));
		$('btn-undo').addEventListener('click', () => emit('undo'));
		$('btn-hint').addEventListener('click', () => emit('hint'));
		$('power').addEventListener('input', () => { $('power-val').textContent = getPower(); emit('power', getPower()); });
		document.addEventListener('keydown', trapFocus, true);
	}

	function keyLabel(code) {
		const named = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Escape: 'Esc', Space: 'Space', NumpadEnter: 'Num Enter' };
		if (named[code]) return named[code];
		if (/^Key[A-Z]$/.test(code)) return code.slice(3);
		if (/^Digit\d$/.test(code)) return code.slice(5);
		return String(code).replace(/[^\w ]/g, '');
	}

	// Help lists the effective keyboard bindings ({ action: codes[] }).
	function renderControlsHelp(b) {
		const k = (a) => (b[a] || []).map(keyLabel).join(' / ');
		renderHelp([
			{ action: 'Aim', keys: 'Drag from ball, or ' + k('aim_left') + ' / ' + k('aim_right') + ' rotate (hold Shift for fine)' },
			{ action: 'Power', keys: 'Drag distance, or ' + k('power_up') + ' / ' + k('power_down') + ' (slider)' },
			{ action: 'Strike', keys: 'Release drag, ' + k('strike') + ', or Strike button' },
			{ action: 'Cancel aim', keys: k('cancel') + ' or release outside' },
			{ action: 'Pause', keys: k('pause') + ' or ⏸ button' },
			{ action: 'Undo (practice)', keys: k('undo') },
			{ action: 'Hint', keys: k('hint') },
			{ action: 'Camera reset', keys: k('camera') },
			{ action: 'Fast-forward roll', keys: k('fast_forward') },
		]);
	}

	// Account buttons on the title (sign-in on the hosted domain without a token,
	// invite when signed in).
	function setAccountButtons(o) {
		$('m-signin').hidden = !o.signIn;
		$('m-invite').hidden = !o.invite;
	}

	function init(settings, progress, bindings) {
		ui.settings = settings;
		ui.progress = progress;
		bind();
		renderSettings();
		renderControlsHelp(bindings);
		applySettingsToDom();
	}

	PG.ui = {
		init, on, showScreen, openOverlay, closeOverlay, anyOverlayOpen, topOverlay,
		toast, announce, caption, setHud, setRails, setPower, getPower, setControls,
		setAccount, setSync, setAccountButtons, renderControlsHelp, escapeHtml,
		renderSettings, renderGraphics, updateGraphicsSummary, renderSetup, renderResults, applySettingsToDom,
		get settings() { return ui.settings; },
		set settings(v) { ui.settings = v; },
		get progress() { return ui.progress; },
		set progress(v) { ui.progress = v; },
	};
})();
