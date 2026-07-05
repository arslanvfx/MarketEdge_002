import { useState, useEffect } from "react";

// ─── Main Component ──────────────────────────────────────────────────────────

// ─── Animated countdown cell for Market Selection table ─────────────────────
//
// Countdown end times are derived from windowKey (wall-clock math) rather than
// the server-reported remaining seconds.  This means the countdown is accurate
// even immediately after a server restart — the server's transient "45s remaining"
// snapshot is ignored in favour of reality.
//
// Countdown scenarios:
//   "window buffer (Xs remaining)"           → clears at windowStart + 45 s
//   "window monitor not ready (…)"           → clears at windowStart + 120 s
//   "min-remaining floor (<Xmin remaining)"  → shows time left in the window

type CountdownColor = "amber" | "violet" | "rose";

const COUNTDOWN_COLORS: Record<CountdownColor, { ring: string; text: string; pulse: string }> = {
  amber:  { ring: "stroke-amber-400",  text: "text-amber-400",  pulse: "bg-amber-400"  },
  violet: { ring: "stroke-violet-400", text: "text-violet-400", pulse: "bg-violet-400" },
  rose:   { ring: "stroke-rose-400",   text: "text-rose-400",   pulse: "bg-rose-400"   },
};

function parseCountdownScenario(
  reason: string,
  windowKey: string,
): { label: string; endsAt: number; total: number; color: CountdownColor } | null {
  // windowKey is always UTC ("YYYY-MM-DDTHH:mm" from toISOString().slice(0,16)).
  // Without a "Z" suffix, browsers parse it as LOCAL time → large wrong offset.
  const ws = new Date(windowKey + "Z").getTime();
  if (reason.startsWith("window buffer")) {
    return { label: "Buffer clears in", endsAt: ws + 45_000,       total: 45,      color: "amber"  };
  }
  if (reason.startsWith("window monitor not ready")) {
    return { label: "Monitor ready in", endsAt: ws + 120_000,      total: 120,     color: "violet" };
  }
  if (reason.startsWith("min-remaining floor")) {
    return { label: "Window ends in",   endsAt: ws + 15 * 60_000,  total: 15 * 60, color: "rose"   };
  }
  return null;
}

export function CountdownCell({ reason, windowKey }: { reason: string; windowKey: string }) {
  const scenario = useMemo(() => parseCountdownScenario(reason, windowKey), [reason, windowKey]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!scenario) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [scenario]);

  if (!scenario) {
    return <span className="text-muted-foreground text-xs break-words leading-snug" title={reason}>{reason}</span>;
  }

  const remaining = Math.max(0, Math.round((scenario.endsAt - now) / 1000));
  const expired = remaining === 0;
  const pct = Math.max(0, Math.min(1, remaining / scenario.total));
  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  const timeStr = mins > 0 ? `${mins}m ${String(secs).padStart(2, "0")}s` : `${secs}s`;

  const R = 10;
  const circ = 2 * Math.PI * R;
  const dash = circ * pct;
  const colors = COUNTDOWN_COLORS[scenario.color];

  // When the countdown expires, show a neutral "updating…" spinner instead of
  // freezing on "0s".  The 3-second poll will deliver the fresh eval within moments.
  if (expired) {
    return (
      <div className="flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 animate-pulse inline-block" />
        <span className="text-[10px] text-muted-foreground/60 italic">updating…</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <div className="relative w-6 h-6 flex-shrink-0">
        <svg viewBox="0 0 24 24" className="-rotate-90 w-6 h-6">
          <circle cx="12" cy="12" r={R} fill="none" stroke="currentColor"
            strokeWidth="2.5" className="text-muted-foreground/20" />
          <circle cx="12" cy="12" r={R} fill="none" strokeWidth="2.5"
            strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
            className={`${colors.ring} transition-all duration-900`} />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center">
          <span className={`w-1.5 h-1.5 rounded-full ${colors.pulse} animate-pulse`} />
        </span>
      </div>
      <div className="flex flex-col leading-tight">
        <span className={`text-xs font-mono font-bold tabular-nums ${colors.text}`}>{timeStr}</span>
        <span className="text-[9px] text-muted-foreground/60 whitespace-nowrap">{scenario.label}</span>
      </div>
    </div>
  );
}
