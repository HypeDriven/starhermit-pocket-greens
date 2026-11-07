// Localization: assets/strings.json (keyed by the en-US text, symbolic keys
// too, nine locales) through the engine's strings, with its starhermit.*
// account strings, in the interface language the runtime reports (Options ›
// Language, else the account's or the device's). Markup in the old strings
// (<strong>, <b>, <code>, &amp;) is dropped: the UI draws plain text.
import { strings } from "starhermit:engine";
import * as ui from "starhermit:ui";

strings.load("assets/strings.json");
strings.defaultLocale = "en-US";
ui.setLanguage(strings.locale);
strings.onChange((locale) => ui.setLanguage(locale));

/** Plain text: tags removed, entities decoded. */
export function plain(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'");
}

type Vars = Record<string, string | number>;
/** An en-US string (or symbolic key) in the player's language; `{name}` placeholders from vars. A text with no entry is itself. */
export function T(key: string, vars?: Vars | null): string {
  const k = String(key);
  const s = strings.has(k) ? strings.t(k, vars ?? undefined)
    : vars ? k.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m)) : k;
  return s.indexOf("<") >= 0 || s.indexOf("&") >= 0 ? plain(s) : s;
}
/** The engine's account strings. */
export function S(key: string, vars?: Vars): string { return strings.t(`starhermit.${key}`, vars); }
/** Marks an English key that is translated with T() when shown. */
export const N = (s: string): string => s;
