import { getLang } from "../i18n";

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function cost(usd: number): string {
  return `$${usd < 10 ? usd.toFixed(2) : usd.toFixed(0)}`;
}

const rtf = () => new Intl.RelativeTimeFormat(getLang(), { numeric: "auto", style: "narrow" });

export function ago(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 45) return getLang() === "nl" ? "nu" : "now";
  if (diff < 3600) return rtf().format(-Math.round(diff / 60), "minute");
  if (diff < 86400) return rtf().format(-Math.round(diff / 3600), "hour");
  return rtf().format(-Math.round(diff / 86400), "day");
}

/** Short label for a tool call: the file, the command, the pattern. */
export function toolSummary(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  const path = s(i.file_path) || s(i.path) || s(i.notebook_path);
  const short = (p: string) => p.split(/[\\/]/).slice(-2).join("/");
  switch (name) {
    case "Bash":
      return s(i.command).split("\n")[0];
    case "Grep":
    case "Glob":
      return [s(i.pattern), path && `in ${short(path)}`].filter(Boolean).join(" ");
    case "WebFetch":
      return s(i.url);
    case "WebSearch":
      return s(i.query);
    case "Edit":
      if (Array.isArray(i.files)) return (i.files as string[]).map(short).join(", ");
      return short(path);
    default:
      return path ? short(path) : s(i.description) || s(i.prompt).slice(0, 80);
  }
}
