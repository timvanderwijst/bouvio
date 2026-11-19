import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import { backend } from "../backend";
import type { TerminalChunk } from "../protocol/TerminalChunk";
import type { TerminalExit } from "../protocol/TerminalExit";
import { rpc } from "../store";

function themeFromCss() {
  const css = getComputedStyle(document.documentElement);
  const v = (n: string) => css.getPropertyValue(n).trim();
  return {
    background: v("--sheet"),
    foreground: v("--ink"),
    cursor: v("--accent"),
    selectionBackground: v("--accent-tint"),
    black: v("--ink"),
    brightBlack: v("--mute"),
  };
}

/** A real shell in the thread's folder, on the runner. */
export function Terminal({ threadId }: { threadId: string }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const term = new XTerm({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono"),
      fontSize: 12.5,
      lineHeight: 1.35,
      cursorBlink: true,
      theme: themeFromCss(),
      allowProposedApi: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();
    term.focus();

    let id: string | null = null;
    let disposed = false;
    const queue: string[] = [];
    const write = (tid: string, data: string) => rpc("write_terminal", { id: tid, data }).catch(() => {});
    const un1 = backend.on<TerminalChunk>("terminal-chunk", (c) => c.terminal_id === id && term.write(c.data));
    const un2 = backend.on<TerminalExit>("terminal-exit", (x) => x.terminal_id === id && term.write("\r\n\x1b[2m[process exited]\x1b[0m\r\n"));
    rpc<string>("open_terminal", { thread_id: threadId, cols: term.cols, rows: term.rows })
      .then((tid) => {
        if (disposed) return rpc("close_terminal", { id: tid });
        id = tid;
        queue.splice(0).forEach((d) => write(tid, d));
      })
      .catch((e) => term.write(`\x1b[31m${e}\x1b[0m\r\n`));
    const input = term.onData((d) => (id ? write(id, d) : queue.push(d)));

    const ro = new ResizeObserver(() => {
      fit.fit();
      if (id) rpc("resize_terminal", { id, cols: term.cols, rows: term.rows }).catch(() => {});
    });
    ro.observe(el);
    const mo = new MutationObserver(() => (term.options.theme = themeFromCss()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    return () => {
      disposed = true;
      ro.disconnect();
      mo.disconnect();
      input.dispose();
      un1();
      un2();
      if (id) rpc("close_terminal", { id }).catch(() => {});
      term.dispose();
    };
  }, [threadId]);

  return <div className="terminal" ref={host} />;
}
