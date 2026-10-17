'use strict';
(function () {

// Pocket Greens — game language. One source for every string module (this
// file; gfx-i18n.js and platform-i18n.js read PG.i18n.locale): sh-language.js
// resolves the Language setting — explicit game choice (ui.language) → for
// Automatic the StarHermit account's preferred language → navigator.languages →
// en-US. Strings are keyed by their en-US text (strings.js); EN holds the
// symbolic keys. A change re-applies static markup (data-i18n, data-i18n-aria,
// data-i18n-title) and calls every onChange listener; bootstrap re-renders the
// screens built in code. Sockets and rounds are never touched.

const hasWindow = typeof window !== 'undefined';
const hasModule = typeof module !== 'undefined' && module.exports;
const STR = hasModule && !hasWindow ? require('./strings.js') : window.PG.strings;
const STRINGS = STR.STRINGS, EN = STR.EN;

const LOCALES = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];

let locale = 'en-US';
let table = STRINGS['en-US'];
const listeners = [];

/** Translate an en-US string (or symbolic key); {name} placeholders filled from vars. */
function t(key, vars) {
	let s = table[key];
	if (s == null) s = STRINGS['en-US'][key];
	if (s == null) s = EN[key];
	if (s == null) s = key;
	if (vars) s = String(s).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
	return s;
}

function applyStatic(root) {
	root = root || document;
	root.querySelectorAll('[data-i18n]').forEach(n => { n.textContent = t(n.dataset.i18n); });
	root.querySelectorAll('[data-i18n-aria]').forEach(n => { n.setAttribute('aria-label', t(n.dataset.i18nAria)); });
	root.querySelectorAll('[data-i18n-title]').forEach(n => { n.setAttribute('title', t(n.dataset.i18nTitle)); });
}

function setLocale(next) {
	const resolved = LOCALES.indexOf(next) >= 0 ? next : 'en-US';
	const changed = resolved !== locale;
	locale = resolved;
	table = STRINGS[locale] || STRINGS['en-US'];
	if (!hasWindow || typeof document === 'undefined') return;
	document.documentElement.lang = locale;
	if (document.readyState !== 'loading') applyStatic();
	if (changed) listeners.slice().forEach(fn => { try { fn(locale); } catch (e) { console.error(e); } });
}

function onChange(fn) { listeners.push(fn); }

const api = {
	t, setLocale, onChange, applyStatic, LOCALES,
	get locale() { return locale; },
	language: null,
};

if (hasModule && !hasWindow) { module.exports = api; return; }

window.PG = window.PG || {};
window.PG.i18n = api;
api.language = window.StarHermitLanguage
	? window.StarHermitLanguage.create({ game: 'pocket-greens', supported: LOCALES, apply: setLocale })
	: null;
if (!api.language) setLocale('en-US');
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => applyStatic(), { once: true });
})();
