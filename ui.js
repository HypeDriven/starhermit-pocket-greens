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

	function showScreen(id) {
		for (const s of SCREENS) $(s).classList.toggle('open', s === id);
		if (id) {
			const first = $(id).querySelector('button.primary, button');
			if (first) first.focus();
		}
		emit('screen', id);
	}

	function openOverlay(id) {
		ui.lastFocus = document.activeElement;
		$(id).classList.add('open');
		const first = $(id).querySelector('button.primary, button');
		if (first) first.focus();
	}

	function closeOverlay(id) {
		$(id).classList.remove('open');
		if (ui.lastFocus && document.contains(ui.lastFocus)) ui.lastFocus.focus();
		ui.lastFocus = null;
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
			'<h3>Graphics</h3>' +
			settingRow('Quality tier', '<select data-set="graphics.tier">' +
				['auto', 'low', 'medium', 'high'].map(t => '<option ' + (s.graphics.tier === t ? 'selected' : '') + '>' + t + '</option>').join('') + '</select>') +
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
			settingRow('Replay tutorials', '<button data-action="replay-tutorials">Reset lessons</button>') +
			'<h3>Privacy</h3>' +
			settingRow('Anonymous usage stats', '<input type="checkbox" ' + (s.telemetry.consent ? 'checked' : '') + ' data-set="telemetry.consent">');
		body.querySelectorAll('[data-set]').forEach(el => {
			el.addEventListener('change', () => {
				const path = el.dataset.set.split('.');
				let node = ui.settings;
				for (let i = 0; i < path.length - 1; i++) node = node[path[i]];
				node[path[path.length - 1]] = el.type === 'checkbox' ? el.checked : (el.type === 'range' ? Number(el.value) : el.value);
				emit('settings-changed', ui.settings);
			});
		});
		body.querySelector('[data-action="replay-tutorials"]').addEventListener('click', () => {
			ui.settings.tutorial.completed = {};
			emit('settings-changed', ui.settings);
			toast('Lessons reset');
		});
	}

	function applySettingsToDom() {
		const s = ui.settings;
		document.body.classList.toggle('high-contrast', !!s.graphics.highContrast);
		document.body.classList.toggle('large-text', !!s.graphics.largeText);
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
		$('power').addEventListener('input', () => emit('power', getPower()));
	}

	function init(settings, progress) {
		ui.settings = settings;
		ui.progress = progress;
		bind();
		renderSettings();
		renderHelp([
			{ action: 'Aim', keys: 'Drag from ball, or ←/→ rotate' },
			{ action: 'Power', keys: 'Drag distance, or ↑/↓ (slider)' },
			{ action: 'Strike', keys: 'Release drag, Space, or Strike button' },
			{ action: 'Cancel aim', keys: 'Esc or release outside' },
			{ action: 'Pause', keys: 'P or ⏸ button' },
			{ action: 'Undo (practice)', keys: 'U' },
			{ action: 'Hint', keys: 'H' },
			{ action: 'Camera reset', keys: 'C' },
			{ action: 'Fast-forward roll', keys: 'F' },
		]);
		applySettingsToDom();
	}

	PG.ui = {
		init, on, showScreen, openOverlay, closeOverlay, anyOverlayOpen, topOverlay,
		toast, announce, caption, setHud, setRails, setPower, getPower, setControls,
		renderSettings, renderSetup, renderResults, applySettingsToDom,
		get settings() { return ui.settings; },
		set settings(v) { ui.settings = v; },
		get progress() { return ui.progress; },
		set progress(v) { ui.progress = v; },
	};
})();
