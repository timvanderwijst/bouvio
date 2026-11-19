import { IntlMessageFormat } from "intl-messageformat";
import { useSyncExternalStore } from "react";
import { en, type MessageKey } from "./en";
import { nl } from "./nl";
import { enMore, nlMore, type MoreKey } from "./more";

// English is complete; every other language falls back to it per message.
// Adding a language = one file + one line here.
type Key = MessageKey | MoreKey;
const EN: Record<Key, string> = { ...en, ...enMore };

export const LANGUAGES = {
  en: { name: "English", messages: EN as Partial<Record<Key, string>> },
  nl: { name: "Nederlands", messages: { ...nl, ...nlMore } as Partial<Record<Key, string>> },
} as const;

export type Lang = keyof typeof LANGUAGES;

const KEY = "bouvio.lang";
const listeners = new Set<() => void>();
const cache = new Map<string, IntlMessageFormat>();

function initial(): Lang {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && saved in LANGUAGES) return saved as Lang;
  } catch {}
  const nav = (navigator.language || "en").slice(0, 2);
  return (nav in LANGUAGES ? nav : "en") as Lang;
}

let lang: Lang = initial();
document.documentElement.lang = lang;

export function getLang() {
  return lang;
}

export function setLang(next: Lang) {
  lang = next;
  document.documentElement.lang = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {}
  listeners.forEach((l) => l());
}

export function t(key: Key, values?: Record<string, string | number>): string {
  const source = LANGUAGES[lang].messages[key] ?? EN[key] ?? key;
  if (!values && !source.includes("{")) return source;
  const id = `${lang}:${key}`;
  let fmt = cache.get(id);
  if (!fmt) {
    fmt = new IntlMessageFormat(source, lang);
    cache.set(id, fmt);
  }
  return String(fmt.format(values));
}

/** Re-render on language change. Returns `t` for convenience. */
export function useT() {
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => lang,
  );
  return t;
}
