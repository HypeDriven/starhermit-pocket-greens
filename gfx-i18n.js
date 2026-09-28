'use strict';
(function () {

// Pocket Greens — localized strings for the Graphics settings section. The locale comes from
// the browser language (the game has no language setting); unknown locales fall back to en-US.

const S = {};

S['en-US'] = {
	graphics: 'Graphics', quality: 'Quality', auto: 'Auto (detected: {tier})',
	low: 'Low', balanced: 'Balanced', high: 'High', ultra: 'Ultra',
	renderScale: 'Render scale', fromPreset: 'From preset ({tier})',
	adaptive: 'Adaptive resolution', showFps: 'Show frame rate',
	cat: { shadows: 'Shadows', ao: 'Ambient occlusion', bloom: 'Bloom', grade: 'Color grade', antialias: 'Anti-aliasing',
		reflections: 'Reflections', water: 'Water', particles: 'Particles', detail: 'Garden detail' },
	tier: { off: 'Off', on: 'On', low: 'Low', medium: 'Medium', high: 'High', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
		static: 'Still', animated: 'Animated', plain: 'Plain', detailed: 'Detailed' },
	sum: { noShadows: 'no shadows', shadows: '{n}² shadows', ao: 'ambient occlusion', aoHigh: 'full ambient occlusion',
		bloom: 'bloom', reflections: 'reflections', noAA: 'no anti-aliasing' },
	postUnavailable: 'Post-processing is unavailable on this device; the game renders without it.',
	unknownGpu: 'unknown GPU',
};

S['en-GB'] = Object.assign({}, S['en-US'], {
	cat: Object.assign({}, S['en-US'].cat, { grade: 'Colour grade' }),
});

S['es-419'] = {
	graphics: 'Gráficos', quality: 'Calidad', auto: 'Automática (detectada: {tier})',
	low: 'Baja', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra',
	renderScale: 'Escala de renderizado', fromPreset: 'Según el ajuste ({tier})',
	adaptive: 'Resolución adaptable', showFps: 'Mostrar fotogramas por segundo',
	cat: { shadows: 'Sombras', ao: 'Oclusión ambiental', bloom: 'Resplandor', grade: 'Corrección de color', antialias: 'Suavizado de bordes',
		reflections: 'Reflejos', water: 'Agua', particles: 'Partículas', detail: 'Detalle del jardín' },
	tier: { off: 'Desactivado', on: 'Activado', low: 'Bajo', medium: 'Medio', high: 'Alto', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
		static: 'Quieta', animated: 'Animada', plain: 'Sencillo', detailed: 'Detallado' },
	sum: { noShadows: 'sin sombras', shadows: 'sombras {n}²', ao: 'oclusión ambiental', aoHigh: 'oclusión ambiental completa',
		bloom: 'resplandor', reflections: 'reflejos', noAA: 'sin suavizado' },
	postUnavailable: 'El posprocesamiento no está disponible en este dispositivo; el juego se muestra sin él.',
	unknownGpu: 'GPU desconocida',
};

S['es-ES'] = Object.assign({}, S['es-419'], {
	adaptive: 'Resolución adaptativa', showFps: 'Mostrar imágenes por segundo',
	cat: Object.assign({}, S['es-419'].cat, { antialias: 'Antialiasing' }),
	postUnavailable: 'El posprocesado no está disponible en este dispositivo; el juego se muestra sin él.',
});

S['de-DE'] = {
	graphics: 'Grafik', quality: 'Qualität', auto: 'Automatisch (erkannt: {tier})',
	low: 'Niedrig', balanced: 'Ausgewogen', high: 'Hoch', ultra: 'Ultra',
	renderScale: 'Renderskalierung', fromPreset: 'Laut Voreinstellung ({tier})',
	adaptive: 'Adaptive Auflösung', showFps: 'Bildrate anzeigen',
	cat: { shadows: 'Schatten', ao: 'Umgebungsverdeckung', bloom: 'Bloom', grade: 'Farbkorrektur', antialias: 'Kantenglättung',
		reflections: 'Spiegelungen', water: 'Wasser', particles: 'Partikel', detail: 'Gartendetails' },
	tier: { off: 'Aus', on: 'An', low: 'Niedrig', medium: 'Mittel', high: 'Hoch', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
		static: 'Ruhig', animated: 'Animiert', plain: 'Schlicht', detailed: 'Detailliert' },
	sum: { noShadows: 'keine Schatten', shadows: '{n}²-Schatten', ao: 'Umgebungsverdeckung', aoHigh: 'volle Umgebungsverdeckung',
		bloom: 'Bloom', reflections: 'Spiegelungen', noAA: 'keine Kantenglättung' },
	postUnavailable: 'Nachbearbeitung ist auf diesem Gerät nicht verfügbar; das Spiel wird ohne sie dargestellt.',
	unknownGpu: 'unbekannte GPU',
};

S['fr-FR'] = {
	graphics: 'Graphismes', quality: 'Qualité', auto: 'Automatique (détectée : {tier})',
	low: 'Basse', balanced: 'Équilibrée', high: 'Haute', ultra: 'Ultra',
	renderScale: 'Échelle de rendu', fromPreset: 'Selon le préréglage ({tier})',
	adaptive: 'Résolution adaptative', showFps: 'Afficher la fréquence d’images',
	cat: { shadows: 'Ombres', ao: 'Occlusion ambiante', bloom: 'Flou lumineux', grade: 'Étalonnage des couleurs', antialias: 'Anticrénelage',
		reflections: 'Reflets', water: 'Eau', particles: 'Particules', detail: 'Détails du jardin' },
	tier: { off: 'Désactivé', on: 'Activé', low: 'Bas', medium: 'Moyen', high: 'Élevé', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
		static: 'Calme', animated: 'Animée', plain: 'Simple', detailed: 'Détaillé' },
	sum: { noShadows: 'sans ombres', shadows: 'ombres {n}²', ao: 'occlusion ambiante', aoHigh: 'occlusion ambiante complète',
		bloom: 'flou lumineux', reflections: 'reflets', noAA: 'sans anticrénelage' },
	postUnavailable: 'Le post-traitement n’est pas disponible sur cet appareil ; le jeu s’affiche sans.',
	unknownGpu: 'GPU inconnu',
};

S['fr-CA'] = Object.assign({}, S['fr-FR'], {
	showFps: 'Afficher la fréquence d’images (IPS)',
	cat: Object.assign({}, S['fr-FR'].cat, { bloom: 'Éclat lumineux' }),
	sum: Object.assign({}, S['fr-FR'].sum, { bloom: 'éclat lumineux' }),
	unknownGpu: 'processeur graphique inconnu',
});

S['pt-BR'] = {
	graphics: 'Gráficos', quality: 'Qualidade', auto: 'Automática (detectada: {tier})',
	low: 'Baixa', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra',
	renderScale: 'Escala de renderização', fromPreset: 'Conforme a predefinição ({tier})',
	adaptive: 'Resolução adaptável', showFps: 'Mostrar taxa de quadros',
	cat: { shadows: 'Sombras', ao: 'Oclusão de ambiente', bloom: 'Brilho', grade: 'Correção de cor', antialias: 'Suavização de serrilhado',
		reflections: 'Reflexos', water: 'Água', particles: 'Partículas', detail: 'Detalhes do jardim' },
	tier: { off: 'Desligado', on: 'Ligado', low: 'Baixo', medium: 'Médio', high: 'Alto', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
		static: 'Parada', animated: 'Animada', plain: 'Simples', detailed: 'Detalhado' },
	sum: { noShadows: 'sem sombras', shadows: 'sombras {n}²', ao: 'oclusão de ambiente', aoHigh: 'oclusão de ambiente completa',
		bloom: 'brilho', reflections: 'reflexos', noAA: 'sem suavização' },
	postUnavailable: 'O pós-processamento não está disponível neste dispositivo; o jogo é exibido sem ele.',
	unknownGpu: 'GPU desconhecida',
};

S['it-IT'] = {
	graphics: 'Grafica', quality: 'Qualità', auto: 'Automatica (rilevata: {tier})',
	low: 'Bassa', balanced: 'Bilanciata', high: 'Alta', ultra: 'Ultra',
	renderScale: 'Scala di rendering', fromPreset: 'Da preimpostazione ({tier})',
	adaptive: 'Risoluzione adattiva', showFps: 'Mostra frequenza fotogrammi',
	cat: { shadows: 'Ombre', ao: 'Occlusione ambientale', bloom: 'Bagliore', grade: 'Correzione colore', antialias: 'Antialiasing',
		reflections: 'Riflessi', water: 'Acqua', particles: 'Particelle', detail: 'Dettagli del giardino' },
	tier: { off: 'Disattivato', on: 'Attivato', low: 'Basso', medium: 'Medio', high: 'Alto', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
		static: 'Ferma', animated: 'Animata', plain: 'Semplice', detailed: 'Dettagliato' },
	sum: { noShadows: 'senza ombre', shadows: 'ombre {n}²', ao: 'occlusione ambientale', aoHigh: 'occlusione ambientale completa',
		bloom: 'bagliore', reflections: 'riflessi', noAA: 'senza antialiasing' },
	postUnavailable: 'La post-elaborazione non è disponibile su questo dispositivo; il gioco viene mostrato senza.',
	unknownGpu: 'GPU sconosciuta',
};

const LOCALES = Object.keys(S);

/** Pick the closest supported locale for a BCP 47 tag. */
function pickLocale(tag) {
	const t = String(tag || 'en-US');
	const exact = LOCALES.find(l => l.toLowerCase() === t.toLowerCase());
	if (exact) return exact;
	const lang = t.split('-')[0].toLowerCase();
	const region = (t.split('-')[1] || '').toUpperCase();
	if (lang === 'en') return ['GB', 'IE', 'AU', 'NZ', 'ZA', 'IN'].includes(region) ? 'en-GB' : 'en-US';
	if (lang === 'es') return region === 'ES' ? 'es-ES' : 'es-419';
	if (lang === 'fr') return region === 'CA' ? 'fr-CA' : 'fr-FR';
	if (lang === 'pt') return 'pt-BR';
	if (lang === 'de') return 'de-DE';
	if (lang === 'it') return 'it-IT';
	return 'en-US';
}

function strings(tag) {
	if (tag == null && typeof navigator !== 'undefined') tag = navigator.language;
	return S[pickLocale(tag)];
}

const api = { STRINGS: S, LOCALES, pickLocale, strings };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else { window.PG = window.PG || {}; window.PG.gfxI18n = api; }
})();
