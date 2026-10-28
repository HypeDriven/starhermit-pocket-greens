// Localization: the browser build's string tables (js/strings.js, keyed by
// the en-US text, symbolic keys in EN) in the interface language the runtime
// reports (preferences().language: Options › Language, else the account's
// or the device's). The runtime's Options replaced the game's own Language
// selector (sh-language.js). Markup in the old strings (<strong>, <b>,
// <code>, &amp;) is dropped: the UI draws plain text.
import { onPreferencesChange, preferences } from "starhermit:engine";
import * as ui from "starhermit:ui";
import { Strings } from "./classic.ts";

export const LOCALES = ["en-US", "en-GB", "es-419", "es-ES", "de-DE", "fr-FR", "fr-CA", "pt-BR", "it-IT"];
const PRIMARY: Record<string, string> = { en: "en-US", es: "es-419", de: "de-DE", fr: "fr-FR", pt: "pt-BR", it: "it-IT" };

/** The shipped locale nearest a BCP 47 tag (en-GB, es-ES and fr-CA by region). */
export function pickLocale(tag: string): string {
  const s = String(tag || "en-US");
  const exact = LOCALES.find((l) => l.toLowerCase() === s.toLowerCase());
  if (exact) return exact;
  const lang = s.split("-")[0]!.toLowerCase();
  if (lang === "en" && /-(gb|ie|au|nz|za|in)$/i.test(s)) return "en-GB";
  if (lang === "es" && /-es$/i.test(s)) return "es-ES";
  if (lang === "fr" && /-ca$/i.test(s)) return "fr-CA";
  return PRIMARY[lang] ?? "en-US";
}

let locale = "";
let table: Record<string, string> = {};
function apply(tag: string): void {
  const next = pickLocale(tag);
  if (next === locale) return;
  locale = next;
  table = Strings.STRINGS[locale] ?? {};
  ui.setLanguage(locale);
}
apply(preferences().language);
onPreferencesChange((p) => apply(p.language));

export function currentLocale(): string { return locale; }

/** Plain text: tags removed, entities decoded. */
export function plain(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'");
}

type Vars = Record<string, string | number>;
/** An en-US string (or symbolic key) in the player's language; `{name}` placeholders from vars. */
export function T(key: string, vars?: Vars | null): string {
  let s = table[key] ?? Strings.EN[key] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
  return s.indexOf("<") >= 0 || s.indexOf("&") >= 0 ? plain(s) : s;
}
/** Marks an English key that is translated with T() when shown. */
export const N = (s: string): string => s;
