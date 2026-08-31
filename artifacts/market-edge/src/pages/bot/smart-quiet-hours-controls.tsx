import React from "react";
import type { BotConfig, BotStatus, QuietHoursV2 } from "./types";
import { QuietHoursGrid } from "./quiet-hours-grid";
import {
  mergePerSymbolQuietHoursForDisplay,
  PerSymbolQuietHoursPanel,
} from "./per-symbol-quiet-hours-panel";

interface SmartQuietHoursControlsProps {
  cfg: BotConfig;
  draft: Partial<BotConfig>;
  setDraft: React.Dispatch<React.SetStateAction<Partial<BotConfig>>>;
  authPost: (path: string, body: object) => Promise<unknown>;
  status?: BotStatus;
  onImmediateSaveError?: (message: string) => void;
}

const EMPTY_QUIET_HOURS: QuietHoursV2 = {
  enabled: false,
  silencedUtcHours: [],
  reducedBetUtcHours: {},
};

export function SmartQuietHoursControls({
  cfg,
  draft,
  setDraft,
  authPost,
  status,
  onImmediateSaveError,
}: SmartQuietHoursControlsProps) {
  const merged = { ...cfg, ...draft } as BotConfig;
  const visiblePerSymbolQuietHours = React.useMemo(
    () => mergePerSymbolQuietHoursForDisplay(
      cfg.perSymbolQuietHours ?? {},
      draft.perSymbolQuietHours ?? {},
    ),
    [cfg.perSymbolQuietHours, draft.perSymbolQuietHours],
  );

  return (
    <div className="min-w-0">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <span className="text-xs font-medium text-muted-foreground">Quiet Hours Mode</span>
        <div className="flex gap-0.5 rounded-md bg-secondary/50 p-0.5">
          {(["global", "per_market"] as const).map(mode => (
            <button
              type="button"
              key={mode}
              onClick={() => setDraft(current => ({ ...current, quietHoursMode: mode }))}
              className={`rounded px-3 py-1 text-xs transition-colors ${
                (merged.quietHoursMode ?? "global") === mode
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {mode === "global" ? "Global" : "Per Market"}
            </button>
          ))}
        </div>
        {(merged.quietHoursMode ?? "global") === "per_market" && (
          <span className="text-[10px] text-muted-foreground/70">
            Auto-calibrated hourly per coin from live bet history
          </span>
        )}
      </div>

      {(merged.quietHoursMode ?? "global") === "global" ? (
        <QuietHoursGrid
          value={merged.quietHoursV2 ?? EMPTY_QUIET_HOURS}
          onChange={quietHoursV2 => setDraft(current => ({ ...current, quietHoursV2 }))}
          onSave={quietHoursV2 => {
            setDraft(current => ({ ...current, quietHoursV2 }));
            authPost("/crypto/bot/config", { quietHoursV2 }).catch(error => {
              onImmediateSaveError?.(error instanceof Error ? error.message : "Unable to save Smart Quiet Hours");
            });
          }}
          autoTuneLastRunAt={status?.autoTuneQHLastRunAt}
          autoTuneLastChanges={status?.autoTuneQHLastChanges}
        />
      ) : (
        <>
          {(() => {
            const masterOn = merged.quietHoursV2?.enabled ?? false;
            const setMaster = (enabled: boolean) => {
              const quietHoursV2 = {
                ...(merged.quietHoursV2 ?? EMPTY_QUIET_HOURS),
                enabled,
              };
              setDraft(current => ({ ...current, quietHoursV2 }));
              authPost("/crypto/bot/config", { quietHoursV2 }).catch(error => {
                onImmediateSaveError?.(error instanceof Error ? error.message : "Unable to save Smart Quiet Hours");
              });
            };
            return (
              <div
                className="mb-3 flex items-center justify-between gap-3 rounded-md border border-border bg-secondary/30 px-3 py-2"
                data-testid="container-per-market-master"
              >
                <div className="flex min-w-0 flex-col">
                  <span className="text-xs font-medium text-foreground" data-testid="text-per-market-master-label">
                    Smart Hours enforcement
                  </span>
                  <span className="text-[10px] text-muted-foreground/70" data-testid="status-per-market-master">
                    {masterOn
                      ? "On — each coin's schedule is enforced"
                      : "Off — all coins trade the full clock (per-coin schedules are NOT enforced)"}
                  </span>
                </div>
                <div className="flex shrink-0 gap-0.5 rounded-md bg-secondary/50 p-0.5">
                  <button
                    type="button"
                    onClick={() => setMaster(true)}
                    data-testid="button-per-market-master-on"
                    className={`rounded px-3 py-1 text-xs transition-colors ${masterOn ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                  >
                    On
                  </button>
                  <button
                    type="button"
                    onClick={() => setMaster(false)}
                    data-testid="button-per-market-master-off"
                    className={`rounded px-3 py-1 text-xs transition-colors ${!masterOn ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                  >
                    Off
                  </button>
                </div>
              </div>
            );
          })()}
          <PerSymbolQuietHoursPanel
            perSymbolQuietHours={visiblePerSymbolQuietHours}
            masterEnabled={merged.quietHoursV2?.enabled ?? false}
            calibrationThreshold={merged.quietHoursV2?.autoTuneThreshold ?? 84.5}
            onCalibrationThresholdChange={threshold => {
              const quietHoursV2 = {
                ...(merged.quietHoursV2 ?? EMPTY_QUIET_HOURS),
                autoTuneThreshold: threshold,
              };
              setDraft(current => ({ ...current, quietHoursV2 }));
              authPost("/crypto/bot/config", { quietHoursV2 }).catch(error => {
                onImmediateSaveError?.(error instanceof Error ? error.message : "Unable to save Smart Hours threshold");
              });
            }}
            onChange={(symbol, schedule) => setDraft(current => ({
              ...current,
              perSymbolQuietHours: {
                ...(cfg.perSymbolQuietHours ?? {}),
                ...(current.perSymbolQuietHours ?? {}),
                [symbol]: schedule,
              },
            }))}
            authPost={authPost}
            onImmediateSaveError={onImmediateSaveError}
            dgCap={merged.dataGatheringBetCap ?? 1}
            dgEnabled={merged.dataGatheringEnabled ?? true}
            symbolSmartHoursModes={status?.symbolSmartHoursModes}
          />
        </>
      )}
    </div>
  );
}
