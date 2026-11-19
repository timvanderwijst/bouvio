import type { AgentStatus } from "../protocol/AgentStatus";

/** Status as a shape, not a label: a spinning arc, a hollow ring, a filled dot. */
export function StatusIcon({ status, size = 14 }: { status: AgentStatus; size?: number }) {
  const r = 5;
  const c = 2 * Math.PI * r;
  return (
    <svg className={`status status-${status}`} width={size} height={size} viewBox="0 0 14 14" aria-hidden>
      {status === "working" && (
        <>
          <circle cx="7" cy="7" r={r} fill="none" stroke="currentColor" strokeOpacity=".22" strokeWidth="2" />
          <circle className="status-arc" cx="7" cy="7" r={r} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray={`${c * 0.3} ${c}`} />
        </>
      )}
      {status === "blocked" && (
        <>
          <circle cx="7" cy="7" r="6" fill="currentColor" />
          <rect x="6.1" y="3.4" width="1.8" height="4.6" rx=".9" fill="var(--sheet)" />
          <circle cx="7" cy="10.1" r="1" fill="var(--sheet)" />
        </>
      )}
      {status === "error" && (
        <>
          <circle cx="7" cy="7" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M5 5l4 4M9 5l-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </>
      )}
      {status === "done" && (
        <>
          <circle cx="7" cy="7" r="6" fill="currentColor" />
          <path d="M4.4 7.2l1.8 1.8 3.5-3.6" fill="none" stroke="var(--sheet)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
      {status === "idle" && <circle cx="7" cy="7" r="4.75" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2 1.8" />}
    </svg>
  );
}
