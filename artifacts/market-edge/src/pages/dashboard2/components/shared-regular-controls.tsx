import React from "react";
import { useAuth } from "@clerk/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Loader2, Save, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { BotConfig, BotStatus } from "../../bot/types";
import { API_BASE } from "../../bot/utils";
import { readApiResponse } from "../../bot/api-response";
import { SmartQuietHoursControls } from "../../bot/smart-quiet-hours-controls";
import { PerCoinOverrides } from "../../bot/per-coin-overrides";

type ConfigResponse = {
  ok?: boolean;
  persisted?: boolean;
  config?: BotConfig;
  error?: string;
};

function isBotStatus(value: unknown): value is BotStatus {
  return Boolean(value && typeof value === "object" && (value as BotStatus).config);
}

export function SharedRegularControls() {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  const [draft, setDraft] = React.useState<Partial<BotConfig>>({});
  const [saving, setSaving] = React.useState(false);
  const [feedback, setFeedback] = React.useState<{ ok: boolean; message: string } | null>(null);

  const statusQuery = useQuery<BotStatus>({
    queryKey: ["bot-status"],
    queryFn: async () => {
      const token = await getToken();
      const response = await fetch(`${API_BASE}/crypto/bot/status`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const payload = await readApiResponse(response);
      if (!isBotStatus(payload)) throw new Error("Regular bot status returned an invalid response");
      return payload;
    },
    refetchInterval: 5_000,
  });

  const applyCanonicalConfig = React.useCallback((config: BotConfig) => {
    queryClient.setQueryData<BotStatus>(["bot-status"], current => (
      current ? { ...current, config } : current
    ));
  }, [queryClient]);

  const authPost = React.useCallback(async (path: string, body: object): Promise<unknown> => {
    const token = await getToken();
    const response = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const payload = await readApiResponse(response);
    if (path === "/crypto/bot/config") {
      const result = payload as ConfigResponse;
      if (result.ok === false || result.error || result.persisted !== true || !result.config) {
        throw new Error(result.error ?? "Settings were not persisted");
      }
      applyCanonicalConfig(result.config);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["bot-status"] }),
        queryClient.invalidateQueries({ queryKey: ["bot-coin-guard-state"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard2-status"] }),
      ]);
    } else if (path.startsWith("/crypto/bot/")) {
      await queryClient.invalidateQueries({ queryKey: ["bot-status"] });
    }
    return payload;
  }, [applyCanonicalConfig, getToken, queryClient]);

  const save = async () => {
    if (Object.keys(draft).length === 0 || saving) return;
    setSaving(true);
    setFeedback(null);
    try {
      const result = await authPost("/crypto/bot/config", draft) as ConfigResponse;
      if (!result.config) throw new Error("Canonical configuration was not returned");
      setDraft({});
      setFeedback({ ok: true, message: "Regular-bot controls saved" });
      window.setTimeout(() => setFeedback(null), 3_000);
    } catch (error) {
      setFeedback({
        ok: false,
        message: error instanceof Error ? error.message : "Unable to save regular-bot controls",
      });
    } finally {
      setSaving(false);
    }
  };

  if (statusQuery.isLoading && !statusQuery.data) {
    return (
      <div className="flex min-h-40 items-center justify-center gap-2 rounded-xl border bg-card text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading shared regular-bot controls…
      </div>
    );
  }

  if (statusQuery.isError || !statusQuery.data?.config) {
    return (
      <div className="flex min-h-40 items-center justify-center gap-2 rounded-xl border border-rose-500/30 bg-card p-4 text-sm text-rose-400">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        {statusQuery.error instanceof Error ? statusQuery.error.message : "Regular-bot configuration is unavailable"}
      </div>
    );
  }

  const cfg = statusQuery.data.config;
  const merged = { ...cfg, ...draft } as BotConfig;
  const hasDraft = Object.keys(draft).length > 0;

  return (
    <section className="min-w-0 space-y-5 rounded-xl border border-cyan-500/20 bg-card p-3 shadow-sm sm:p-5">
      <div className="flex flex-col gap-3 border-b border-border/50 pb-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-sm font-bold text-cyan-400">
            <Shield className="h-4 w-4" /> Shared Regular-Bot Safety &amp; Limits
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Canonical Bot 1 controls shared across dashboards. These do not change Dashboard 2 ledger configuration.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {feedback && (
            <span className={`flex items-center gap-1 text-xs ${feedback.ok ? "text-emerald-400" : "text-rose-400"}`}>
              {feedback.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
              {feedback.message}
            </span>
          )}
          <Button type="button" size="sm" onClick={save} disabled={!hasDraft || saving}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
            Save Regular Controls
          </Button>
        </div>
      </div>
      <SmartQuietHoursControls
        cfg={cfg}
        draft={draft}
        setDraft={setDraft}
        authPost={authPost}
        status={statusQuery.data}
        onImmediateSaveError={message => setFeedback({ ok: false, message })}
      />
      <PerCoinOverrides
        value={merged.coinOverrides}
        globalMax={merged.maxBetSize ?? 2}
        onChange={coinOverrides => setDraft(current => ({ ...current, coinOverrides }))}
      />
    </section>
  );
}
