import { ArrowUp, GitBranch, Mic, Monitor, ShieldCheck, Square } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { backend } from "../backend";
import { useT } from "../i18n";
import type { ApprovalLevel } from "../protocol/ApprovalLevel";
import type { Effort } from "../protocol/Effort";
import type { HarnessKind } from "../protocol/HarnessKind";
import type { Thread } from "../protocol/Thread";
import { draftKey, useStore } from "../store";
import { Menu, type MenuItem } from "./Menu";
import { HarnessIcon, HARNESS_NAMES, MODELS } from "./harness";

export function Composer({ thread }: { thread: Thread | null }) {
  const t = useT();
  const view = useStore((s) => s.view);
  const key = draftKey(view);
  const draft = useStore((s) => s.drafts[key] ?? "");
  const setDraft = useStore((s) => s.setDraft);
  const send = useStore((s) => s.send);
  const stop = useStore((s) => s.stop);
  const prefs = useStore((s) => s.prefs);
  const setPrefs = useStore((s) => s.setPrefs);
  const harnesses = useStore((s) => s.harnesses);
  const models = useStore((s) => s.models);
  const providers = useStore((s) => s.providers);
  const notify = useStore((s) => s.notify);
  const ws = useStore((s) => s.workspaces.find((w) => w.id === s.workspaceId));
  const captain = useStore((s) =>
    view.kind === "draft" && view.captainId && s.workspaceId ? (s.captains[s.workspaceId] ?? []).find((c) => c.id === view.captainId) : null,
  );
  const ref = useRef<HTMLTextAreaElement>(null);

  // Settings are chosen before the first message; after that they belong to the thread.
  const locked = !!thread || !!captain;
  const harness: HarnessKind = thread?.harness ?? captain?.harness ?? prefs.harness;
  const model = thread?.model ?? captain?.model ?? prefs.model;
  const effort: Effort = thread?.effort ?? captain?.effort ?? prefs.effort;
  const approval: ApprovalLevel = thread?.approval ?? captain?.approval ?? prefs.approval;
  const working = thread?.status === "working";

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = Math.min(el.scrollHeight, 240) + "px";
  }, [draft]);

  useEffect(() => {
    ref.current?.focus();
  }, [key]);

  const submit = () => {
    if (!draft.trim() || working) return;
    send(draft);
  };

  // One menu for "who runs it": harness and model together.
  const runItems: MenuItem<string>[] = harnesses
    .filter((h) => h.kind !== "api")
    .flatMap((h) =>
      (MODELS[h.kind] ?? [{ id: null, label: "Default" }]).map((m) => ({
        value: `${h.kind}|${m.id ?? ""}`,
        label: `${HARNESS_NAMES[h.kind]} · ${m.id ? m.label : t("composer.defaultModel")}`,
        icon: <HarnessIcon kind={h.kind} />,
        hint: h.available ? undefined : t("composer.notInstalled"),
        disabled: !h.available,
      })),
    );
  // Models from the user's own keys run in Bouvio's agent loop.
  const keyed = new Set(providers.filter((p) => p.configured).map((p) => p.kind));
  for (const m of models.filter((m) => keyed.has(m.provider) || m.provider === "open_router").slice(0, 60)) {
    runItems.push({
      value: `api|${m.id}`,
      label: m.name,
      icon: <HarnessIcon kind="api" />,
      hint: keyed.has(m.provider) ? m.provider.replace("_", "") : t("composer.needsKey"),
      disabled: !keyed.has(m.provider),
    });
  }
  const efforts: Effort[] = ["low", "medium", "high", "max"];
  const approvals: ApprovalLevel[] = ["ask_all", "ask_risky", "free"];
  const modelLabel =
    harness === "api"
      ? models.find((m) => m.id === model)?.name ?? model?.split(":").pop() ?? t("composer.chooseModel")
      : MODELS[harness]?.find((m) => m.id === model)?.label ?? model ?? t("composer.defaultModel");
  const runLabel = harness === "api" ? modelLabel : `${HARNESS_NAMES[harness]} · ${modelLabel}`;
  const voice = useVoice((text) => setDraft(key, (draft ? draft + " " : "") + text), notify);

  return (
    <div className="composer-wrap">
      <form
        className={`composer ${working ? "is-working" : ""}`}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <textarea
          ref={ref}
          value={draft}
          rows={1}
          placeholder={thread ? t("composer.placeholderReply") : t("composer.placeholder")}
          onChange={(e) => setDraft(key, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="composer-bar">
          <button
            type="button"
            className={`icon-btn ${voice.state === "recording" ? "rec" : voice.state === "busy" ? "spin-soft" : ""}`}
            onClick={voice.toggle}
            title={t("composer.voice")}
            aria-label={t("composer.voice")}
          >
            <Mic size={15} />
          </button>
          <Menu
            value={`${harness}|${model ?? ""}`}
            items={runItems}
            onChange={(v) => {
              const [h, m] = v.split("|");
              setPrefs({ harness: h as HarnessKind, model: m || null });
            }}
            label={runLabel}
            icon={<HarnessIcon kind={harness} />}
            disabled={locked}
            up
          />
          <Menu
            value={effort}
            items={efforts.map((e) => ({ value: e, label: t(`effort.${e}`) }))}
            onChange={(e) => setPrefs({ effort: e })}
            disabled={locked}
            up
          />
          <div className="composer-spacer" />
          {working ? (
            <button type="button" className="send stop" onClick={() => thread && stop(thread.id)} aria-label={t("composer.stop")} title={t("composer.stop")}>
              <Square size={11} fill="currentColor" />
            </button>
          ) : (
            <button type="submit" className="send" disabled={!draft.trim()} aria-label={t("composer.send")} title={t("composer.send")}>
              <ArrowUp size={16} strokeWidth={2.25} />
            </button>
          )}
        </div>
      </form>
      <div className="composer-foot">
        <span className="runner-pill">
          <Monitor size={13} />
          {ws?.host ? t("composer.runnerOf", { name: ws.host.name }) : t("composer.thisComputer")}
          <span className="online" />
        </span>
        <Menu
          value={approval}
          items={approvals.map((a) => ({ value: a, label: t(`approval.${a}`) }))}
          onChange={(a) => setPrefs({ approval: a })}
          icon={<ShieldCheck size={13} />}
          disabled={locked}
          up
        />
        {!locked && ws?.root && (
          <label className="toggle">
            <input type="checkbox" checked={prefs.isolate} onChange={(e) => setPrefs({ isolate: e.target.checked })} />
            <GitBranch size={13} />
            {t("composer.isolate")}
          </label>
        )}
        {thread?.branch && (
          <span className="branch">
            <GitBranch size={12} />
            {thread.branch}
          </span>
        )}
      </div>
    </div>
  );
}

/** Hold a conversation by voice: record in the window, transcribe with the user's key. */
function useVoice(onText: (t: string) => void, onError: (e: string) => void) {
  const [state, setState] = useState<"idle" | "recording" | "busy">("idle");
  const rec = useRef<MediaRecorder | null>(null);
  const toggle = async () => {
    if (state === "recording") {
      rec.current?.stop();
      return;
    }
    if (state === "busy") return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const r = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      r.ondataavailable = (e) => chunks.push(e.data);
      r.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setState("busy");
        try {
          const blob = new Blob(chunks, { type: r.mimeType });
          const buf = new Uint8Array(await blob.arrayBuffer());
          let bin = "";
          for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
          onText(await backend.transcribe(btoa(bin), r.mimeType));
        } catch (e) {
          onError(String(e));
        } finally {
          setState("idle");
        }
      };
      rec.current = r;
      r.start();
      setState("recording");
    } catch (e) {
      onError(String(e));
    }
  };
  return { state, toggle };
}
