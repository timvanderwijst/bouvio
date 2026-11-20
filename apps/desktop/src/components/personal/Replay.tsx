import { AlertTriangle, ChevronLeft, ChevronRight, MessageSquare, Pause, Play, ShieldQuestion, Sparkles, Wrench, Flag, Dot } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../i18n";
import type { Replay } from "../../protocol/Replay";
import type { ReplayKind } from "../../protocol/ReplayKind";
import type { ReplayStep } from "../../protocol/ReplayStep";
import type { Thread } from "../../protocol/Thread";
import { rpc, useStore } from "../../store";
import { cost, duration } from "../../lib/format";
import { Markdown } from "../Markdown";
import { Empty } from "../Panel";

const SPEEDS = [1, 4, 16] as const;
/** While playing, a quiet stretch longer than this (in screen time) is skipped. */
const MAX_IDLE_MS = 1200;

const ICONS: Record<ReplayKind, typeof Play> = {
  message: MessageSquare,
  reply: Sparkles,
  tool: Wrench,
  approval: ShieldQuestion,
  error: AlertTriangle,
  turn: Flag,
  other: Dot,
};

function clock(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const p = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${p(m % 60)}:${p(s % 60)}` : `${m}:${p(s % 60)}`;
}

/** Panel tab: watch a thread happen again, step by step. */
export function ReplayPanel({ thread }: { thread: Thread | null }) {
  const t = useT();
  const turns = useStore((s) => (thread ? (s.events[thread.id] ?? []).filter((e) => e.event.type === "turn_complete").length : 0));
  const [data, setData] = useState<Replay | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(4);

  useEffect(() => {
    if (!thread) return;
    let live = true;
    rpc<Replay>("thread_replay", { thread_id: thread.id }, thread.workspace_id)
      .then((r) => {
        if (!live) return;
        setData(r);
        setError(null);
      })
      .catch((e) => live && setError(String(e).replace(/^Error: /, "")));
    return () => {
      live = false;
    };
  }, [thread?.id, thread?.workspace_id, turns]);

  // Start at the end the first time a thread loads: the replay is a way back in.
  const shownFor = useRef<string | null>(null);
  useEffect(() => {
    if (data && shownFor.current !== data.thread_id) {
      shownFor.current = data.thread_id;
      setTime(data.total_ms);
      setPlaying(false);
    }
  }, [data]);

  const steps = data?.steps ?? [];
  const total = Math.max(1, data?.total_ms ?? 1);
  const index = useMemo(() => {
    let i = -1;
    for (let k = 0; k < steps.length && steps[k].offset_ms <= time; k++) i = k;
    return i;
  }, [steps, time]);
  const current = index >= 0 ? steps[index] : null;

  // Play: advance the clock, skipping long quiet stretches.
  const raf = useRef(0);
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) * speed;
      last = now;
      setTime((v) => {
        let next = v + dt;
        const upcoming = steps.find((s) => s.offset_ms > v);
        if (upcoming && (upcoming.offset_ms - next) / speed > MAX_IDLE_MS) next = upcoming.offset_ms - MAX_IDLE_MS * speed;
        if (next >= total) {
          setPlaying(false);
          return total;
        }
        return next;
      });
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [playing, speed, steps, total]);

  const go = useCallback((i: number) => {
    const s = steps[Math.max(0, Math.min(steps.length - 1, i))];
    if (s) setTime(s.offset_ms);
  }, [steps]);

  if (!thread) return <Empty text={t("panel.nothing")} />;
  if (error && !data) return <Empty text={error} />;
  if (!data) return <div className="p-replay"><div className="shimmer p-skel-chart" /></div>;
  if (!steps.length) return <Empty text={t("personal.replay.empty")} />;

  return (
    <div className="p-replay">
      <div className="p-replay-bar">
        <button
          type="button"
          className="icon-btn"
          onClick={() => {
            if (!playing && time >= total) setTime(0);
            setPlaying((p) => !p);
          }}
          aria-label={playing ? t("personal.replay.pause") : t("personal.replay.play")}
          title={playing ? t("personal.replay.pause") : t("personal.replay.play")}
        >
          {playing ? <Pause size={15} /> : <Play size={15} />}
        </button>
        <button type="button" className="icon-btn" onClick={() => go(index - 1)} disabled={index <= 0} aria-label={t("personal.replay.prev")} title={t("personal.replay.prev")}>
          <ChevronLeft size={15} />
        </button>
        <button type="button" className="icon-btn" onClick={() => go(index + 1)} disabled={index >= steps.length - 1} aria-label={t("personal.replay.next")} title={t("personal.replay.next")}>
          <ChevronRight size={15} />
        </button>
        <div className="choice small" role="group" aria-label={t("personal.replay.speed")}>
          {SPEEDS.map((s) => (
            <button key={s} type="button" className={speed === s ? "on" : ""} onClick={() => setSpeed(s)}>
              {s}×
            </button>
          ))}
        </div>
        <div className="composer-spacer" />
        <span className="p-replay-clock num">
          {clock(time)} / {clock(total)}
        </span>
        <span className="p-replay-cost num" title={t("personal.replay.costSoFar")}>
          {cost(current?.cost_so_far ?? 0)}
        </span>
      </div>

      <Scrubber steps={steps} total={total} time={time} onSeek={(v) => (setPlaying(false), setTime(v))} />

      {current && <StepDetail step={current} index={index} count={steps.length} />}

      <StepList steps={steps} index={index} onPick={(i) => (setPlaying(false), go(i))} />
    </div>
  );
}

function Scrubber({ steps, total, time, onSeek }: { steps: ReplayStep[]; total: number; time: number; onSeek: (ms: number) => void }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const seek = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    onSeek(Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * total);
  };
  return (
    <div
      ref={ref}
      className="p-scrub"
      role="slider"
      tabIndex={0}
      aria-label={t("personal.replay.timeline")}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={Math.round(time)}
      aria-valuetext={clock(time)}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        seek(e.clientX);
      }}
      onPointerMove={(e) => e.buttons === 1 && seek(e.clientX)}
      onKeyDown={(e) => {
        const by = total / 50;
        if (e.key === "ArrowRight") onSeek(Math.min(total, time + by));
        else if (e.key === "ArrowLeft") onSeek(Math.max(0, time - by));
        else return;
        e.preventDefault();
      }}
    >
      <div className="p-scrub-track">
        <div className="p-scrub-fill" style={{ width: `${(time / total) * 100}%` }} />
      </div>
      {steps.map((s) => (
        <span key={s.seq} className={`p-mark k-${s.kind} ${s.is_error ? "err" : ""} ${s.offset_ms <= time ? "past" : ""}`} style={{ left: `${(s.offset_ms / total) * 100}%` }} />
      ))}
      <span className="p-head" style={{ left: `${(time / total) * 100}%` }} />
    </div>
  );
}

function pretty(v: unknown) {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function StepDetail({ step, index, count }: { step: ReplayStep; index: number; count: number }) {
  const t = useT();
  const e = step.event;
  const Icon = ICONS[step.kind];
  return (
    <section className={`p-step-detail k-${step.kind}`} aria-live="polite">
      <header className="p-step-head">
        <Icon size={14} className="p-step-icon" />
        <span className="p-step-kind">{t(`personal.replay.kind.${step.kind}`)}</span>
        <span className="p-step-n num">
          {index + 1} / {count}
        </span>
        <div className="composer-spacer" />
        {step.duration_ms !== null && <span className="p-step-dur num">{duration(step.duration_ms)}</span>}
        <span className="p-step-at num">+{clock(step.offset_ms)}</span>
      </header>
      {e.type === "user_message" ? (
        <div className="p-step-body">
          <div className="p-step-who">{e.author}</div>
          <Markdown text={e.text} />
        </div>
      ) : e.type === "assistant_text" ? (
        <div className="p-step-body">
          <Markdown text={e.text} />
        </div>
      ) : e.type === "tool_use" ? (
        <>
          <div className="p-step-label mono truncate">{e.name}</div>
          <div className="p-io-label">{t("personal.replay.input")}</div>
          <pre className="p-io">{pretty(e.input)}</pre>
          <div className="p-io-label">{t("personal.replay.output")}</div>
          <pre className={`p-io ${step.is_error ? "err" : ""}`}>{step.output ?? t("personal.replay.noOutput")}</pre>
        </>
      ) : e.type === "approval_request" ? (
        <>
          <div className="p-step-label mono">{e.tool}</div>
          <pre className="p-io">{pretty(e.input)}</pre>
          <div className={`p-step-answer ${step.is_error ? "err" : ""}`}>{step.output ?? t("personal.replay.unanswered")}</div>
        </>
      ) : e.type === "error" ? (
        <pre className="p-io err">{e.message}</pre>
      ) : e.type === "tool_result" ? (
        <pre className={`p-io ${e.is_error ? "err" : ""}`}>{e.output}</pre>
      ) : (
        <div className="p-step-label">{step.label}</div>
      )}
    </section>
  );
}

function StepList({ steps, index, onPick }: { steps: ReplayStep[]; index: number; onPick: (i: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>(`[data-i="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);
  return (
    <div className="p-steps" ref={ref} role="listbox">
      {steps.map((s, i) => {
        const Icon = ICONS[s.kind];
        return (
          <button
            type="button"
            key={s.seq}
            data-i={i}
            role="option"
            aria-selected={i === index}
            className={`p-step k-${s.kind} ${i === index ? "on" : ""} ${i > index ? "future" : ""} ${s.is_error ? "err" : ""}`}
            onClick={() => onPick(i)}
          >
            <Icon size={13} className="p-step-icon" />
            <span className="truncate p-step-text">{s.label}</span>
            {s.gap_ms >= 1000 && <span className="p-step-gap num">+{duration(s.gap_ms)}</span>}
          </button>
        );
      })}
    </div>
  );
}
