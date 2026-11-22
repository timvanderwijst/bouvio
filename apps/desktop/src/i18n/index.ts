import { IntlMessageFormat } from "intl-messageformat";
import { useSyncExternalStore } from "react";
import { en, type MessageKey } from "./en";
import { nl } from "./nl";
import { enMore, nlMore, type MoreKey } from "./more";
import * as aComms from "./areas/comms";
import * as aDev from "./areas/dev";
import * as aKnowledge from "./areas/knowledge";
import * as aLocal from "./areas/local";
import * as aOffice from "./areas/office";
import * as aPersonal from "./areas/personal";
import * as aPlatform from "./areas/platform";

const AREA_MSGS = [aComms, aDev, aKnowledge, aLocal, aOffice, aPersonal, aPlatform];

// English is complete; every other language falls back to it per message.
// Adding a language = one file + one line here.
type Key = MessageKey | MoreKey | (string & {});
const EN: Record<string, string> = Object.assign({ ...en, ...enMore }, ...AREA_MSGS.map((a) => a.en));

export const LANGUAGES = {
  en: { name: "English", messages: EN as Partial<Record<Key, string>> },
  nl: { name: "Nederlands", messages: Object.assign({ ...nl, ...nlMore }, ...AREA_MSGS.map((a) => a.nl)) as Partial<Record<Key, string>> },
} as const;

export type Lang = keyof typeof LANGUAGES;

const KEY = "cuna.lang";
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
