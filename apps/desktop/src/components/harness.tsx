import type { HarnessKind } from "../protocol/HarnessKind";

export const HARNESS_NAMES: Record<HarnessKind, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
  open_code: "OpenCode",
  gemini_cli: "Gemini CLI",
  api: "API",
};

/** Model choices per harness. `null` lets the harness pick its own default. */
export const MODELS: Partial<Record<HarnessKind, { id: string | null; label: string }[]>> = {
  claude_code: [
    { id: null, label: "Default" },
    { id: "opus", label: "Opus" },
    { id: "sonnet", label: "Sonnet" },
    { id: "haiku", label: "Haiku" },
  ],
  codex: [{ id: null, label: "Default" }],
};

/** Neutral marks per harness: no vendor logos in an open-source app. */
export function HarnessIcon({ kind }: { kind: HarnessKind }) {
  const common = { width: 14, height: 14, viewBox: "0 0 14 14", "aria-hidden": true } as const;
  switch (kind) {
    case "claude_code":
      return (
        <svg {...common}>
          <path d="M7 1.5v11M1.5 7h11M3.1 3.1l7.8 7.8M10.9 3.1l-7.8 7.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      );
    case "codex":
      return (
        <svg {...common}>
          <path d="M4.5 4L1.8 7l2.7 3M9.5 4l2.7 3-2.7 3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <rect x="2" y="2" width="10" height="10" rx="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      );
  }
}
