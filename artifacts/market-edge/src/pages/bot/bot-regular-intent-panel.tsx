import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, RefreshCw, ShieldCheck } from "lucide-react";
import type { RegularUnresolvedIntent } from "./types";
import { API_BASE, fmtContracts, wkToEstRange } from "./utils";

interface Props {
  authPost: (path: string, body: object) => Promise<unknown>;
  getToken: () => Promise<string | null>;
}

type ReconcileResponse = {
  ok?: boolean;
  outcome?: "confirmed_fill" | "zero_fill" | "ambiguous";
  reason?: string;
  filledCount?: number;
  settledOutcome?: "win" | "loss" | null;
  error?: string;
};

function displayReason(intent: RegularUnresolvedIntent): string {
  return (intent.reconciliationReason ?? intent.reason ?? "Awaiting authoritative exchange evidence")
    .replace(/_/g, " ");
}

export function BotRegularIntentPanel({ authPost, getToken }: Props) {
  const qc = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const { data } = useQuery<{ intents: RegularUnresolvedIntent[] }>({
    queryKey: ["bot-unresolved-regular-intents"],
    queryFn: async () => {
      const token = await getToken();
      const response = await fetch(`${API_BASE}/crypto/bot/unresolved-intents`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) return { intents: [] };
      return response.json();
    },
    refetchInterval: 15_000,
  });
  const intents = data?.intents ?? [];
  if (intents.length === 0) return null;

  async function reconcile(clientOrderId: string) {
    if (busyId) return;
    setBusyId(clientOrderId);
    setMessage(null);
    try {
      const result = await authPost("/crypto/bot/reconcile-intent", { clientOrderId }) as ReconcileResponse;
      if (result.ok && result.outcome === "confirmed_fill") {
        setMessage({
          ok: true,
          text: `Recovered ${fmtContracts(result.filledCount)} contracts from authenticated Kalshi fills.`,
        });
      } else if (result.ok && result.outcome === "zero_fill") {
        setMessage({ ok: true, text: "Kalshi confirmed this order had zero fills; the reservation was released." });
      } else {
        setMessage({
          ok: false,
          text: result.reason?.replace(/_/g, " ") ?? result.error ?? "Evidence is still ambiguous; exposure remains blocked.",
        });
      }
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["bot-unresolved-regular-intents"] }),
        qc.invalidateQueries({ queryKey: ["bot-status"] }),
        qc.invalidateQueries({ queryKey: ["bot-all-history"] }),
        qc.invalidateQueries({ queryKey: ["bot-stats"] }),
      ]);
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : "Reconciliation request failed." });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="rounded-xl border border-orange-500/35 bg-orange-950/10 p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="rounded-lg border border-orange-500/30 bg-orange-500/10 p-2 text-orange-300">
            <AlertTriangle className="h-4 w-4" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-orange-100">Regular Order Recovery</h2>
            <p className="mt-0.5 text-xs text-orange-100/65">
              {intents.length} live order {intents.length === 1 ? "intent needs" : "intents need"} authoritative Kalshi reconciliation.
              Trading stays blocked for each affected coin and window until the evidence is conclusive.
            </p>
          </div>
        </div>
        <span className="rounded-full border border-orange-500/30 bg-orange-500/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-orange-300">
          {intents.length} unresolved
        </span>
      </div>

      <div className="mt-4 space-y-2">
        {intents.map((intent) => {
          const busy = busyId === intent.clientOrderId;
          return (
            <div key={intent.clientOrderId} className="rounded-lg border border-orange-500/20 bg-black/20 p-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-bold text-foreground">{intent.symbol}</span>
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                      intent.side === "yes"
                        ? "bg-emerald-500/15 text-emerald-300"
                        : "bg-red-500/15 text-red-300"
                    }`}>
                      {intent.side}
                    </span>
                    <span className="rounded bg-orange-500/10 px-1.5 py-0.5 text-[10px] font-bold uppercase text-orange-300">
                      {intent.status}
                    </span>
                    <span className="text-xs text-muted-foreground">{wkToEstRange(intent.windowKey)} ET</span>
                  </div>
                  <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{intent.ticker}</div>
                  <div className="mt-1 text-xs text-orange-100/70">
                    {fmtContracts(intent.requestedCount)} requested
                    {intent.limitPrice != null ? ` at ${(intent.limitPrice * 100).toFixed(0)}¢ YES limit` : ""}
                    {" · "}{displayReason(intent)}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void reconcile(intent.clientOrderId)}
                  disabled={busyId != null}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-orange-400/35 bg-orange-500/10 px-3 py-2 text-xs font-semibold text-orange-200 transition hover:bg-orange-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                  Reconcile with Kalshi
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {message && (
        <div className={`mt-3 rounded-lg border px-3 py-2 text-xs ${
          message.ok
            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
            : "border-red-500/30 bg-red-500/10 text-red-300"
        }`}>
          {message.text}
        </div>
      )}
    </section>
  );
}