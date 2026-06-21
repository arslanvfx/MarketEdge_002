import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Sparkles, Loader2, Save, ShieldCheck, Zap, Flame, Info } from "lucide-react";
import {
  useGenerateSmartPicks,
  useSaveCombo,
  SmartPickResult,
  SmartPicksInputRiskLevel,
  getListCombosQueryKey,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Show } from "@clerk/react";

type RiskLevel = SmartPicksInputRiskLevel;

const RISK_OPTIONS: { value: RiskLevel; label: string; description: string; icon: React.ElementType; color: string }[] = [
  {
    value: "conservative",
    label: "Conservative",
    description: "High-probability legs, modest payouts",
    icon: ShieldCheck,
    color: "text-emerald-400 border-emerald-500/40 bg-emerald-500/10",
  },
  {
    value: "balanced",
    label: "Balanced",
    description: "Mix of probability and upside",
    icon: Zap,
    color: "text-sky-400 border-sky-500/40 bg-sky-500/10",
  },
  {
    value: "aggressive",
    label: "Aggressive",
    description: "Long shots with high multipliers",
    icon: Flame,
    color: "text-orange-400 border-orange-500/40 bg-orange-500/10",
  },
];

const RISK_SCORE_BADGE: Record<SmartPickResult["riskScore"], { label: string; className: string }> = {
  low:    { label: "Low Risk",    className: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" },
  medium: { label: "Med Risk",    className: "bg-amber-500/10 text-amber-400 border-amber-500/20" },
  high:   { label: "High Risk",   className: "bg-red-500/10 text-red-400 border-red-500/20" },
};

function formatProb(p: number) {
  return `${(p * 100).toFixed(1)}%`;
}
function formatMult(m: number) {
  return `${m.toFixed(2)}×`;
}
function formatPayout(n: number) {
  return n >= 1000
    ? `$${(n / 1000).toFixed(1)}k`
    : `$${n.toFixed(2)}`;
}

function ComboCardSkeleton() {
  return (
    <Card className="p-6 space-y-4 animate-pulse">
      <div className="flex justify-between items-start">
        <Skeleton className="h-9 w-28" />
        <Skeleton className="h-6 w-20" />
      </div>
      <Skeleton className="h-px w-full" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
      <div className="flex justify-between pt-2">
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-9 w-28" />
      </div>
    </Card>
  );
}

interface SmartPickCardProps {
  combo: SmartPickResult;
  index: number;
  stake: number;
}

function SmartPickCard({ combo, index, stake }: SmartPickCardProps) {
  const [open, setOpen] = useState(false);
  const [comboName, setComboName] = useState(`Smart Pick #${index + 1}`);
  const saveMutation = useSaveCombo();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const badge = RISK_SCORE_BADGE[combo.riskScore];
  const estimatedPayout = combo.payoutMultiplier * stake;

  const handleSave = () => {
    if (!comboName.trim()) return;
    saveMutation.mutate(
      {
        data: {
          name: comboName.trim(),
          legs: combo.legs.map((l) => ({
            marketId: l.marketId,
            platform: l.platform as any,
            marketTitle: l.marketTitle,
            position: l.position as any,
            oddsAtSave: l.odds,
            impliedProbAtSave: l.impliedProb,
          })),
        },
      },
      {
        onSuccess: () => {
          toast({ title: "Combo saved", description: "Saved to your portfolio." });
          setOpen(false);
          queryClient.invalidateQueries({ queryKey: getListCombosQueryKey() });
          setLocation("/portfolio");
        },
        onError: () => {
          toast({ title: "Save failed", variant: "destructive" });
        },
      },
    );
  };

  return (
    <Card className="overflow-hidden border-border/50 shadow-md flex flex-col">
      {/* Header */}
      <div className="bg-card px-5 py-4 border-b border-border/50 flex items-center justify-between gap-3">
        <div>
          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-0.5">
            Combo {index + 1} · {combo.legs.length} legs
          </p>
          <div className="text-2xl font-bold font-mono text-primary">
            {formatMult(combo.payoutMultiplier)}
          </div>
        </div>
        <div className="text-right space-y-1">
          <Badge variant="outline" className={`text-xs ${badge.className}`}>
            {badge.label}
          </Badge>
          <div className="text-xs text-muted-foreground">
            {formatProb(combo.jointProbability)} prob
          </div>
        </div>
      </div>

      {/* Legs table */}
      <div className="flex-1">
        <table className="w-full text-sm">
          <tbody className="divide-y divide-border/30">
            {combo.legs.map((leg, i) => (
              <tr key={i} className="hover:bg-muted/20">
                <td className="px-4 py-3">
                  <Badge
                    variant="outline"
                    className={
                      leg.position === "yes"
                        ? "bg-primary/10 text-primary border-primary/20 text-[10px]"
                        : "bg-destructive/10 text-destructive border-destructive/20 text-[10px]"
                    }
                  >
                    {leg.position.toUpperCase()}
                  </Badge>
                </td>
                <td className="px-3 py-3 font-medium text-xs leading-snug">{leg.marketTitle}</td>
                <td className="px-4 py-3 text-right font-mono text-xs text-muted-foreground whitespace-nowrap">
                  {formatProb(leg.impliedProb)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Footer */}
      <div className="px-5 py-4 border-t border-border/50 bg-muted/20 flex items-center justify-between gap-3">
        <div className="text-sm">
          <span className="text-muted-foreground">Est. payout </span>
          <span className="font-semibold text-primary font-mono">{formatPayout(estimatedPayout)}</span>
          <span className="text-muted-foreground text-xs"> on ${stake}</span>
        </div>

        <Show when="signed-in">
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button size="sm" variant="outline" data-testid={`button-save-pick-${index}`}>
                <Save className="w-3.5 h-3.5 mr-1.5" />
                Save
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Save Smart Pick</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Name</label>
                  <Input
                    value={comboName}
                    onChange={(e) => setComboName(e.target.value)}
                    placeholder="Give this combo a name"
                    autoFocus
                    data-testid="input-pick-name"
                  />
                </div>
                <div className="bg-muted/50 p-4 rounded-lg space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Legs</span>
                    <span>{combo.legs.length}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Multiplier</span>
                    <span className="font-mono text-primary">{formatMult(combo.payoutMultiplier)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Win probability</span>
                    <span className="font-mono">{formatProb(combo.jointProbability)}</span>
                  </div>
                </div>
                <Button
                  className="w-full"
                  onClick={handleSave}
                  disabled={!comboName.trim() || saveMutation.isPending}
                  data-testid="button-confirm-save-pick"
                >
                  {saveMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                  Confirm Save
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </Show>
      </div>
    </Card>
  );
}

export default function SmartPicks() {
  const [riskLevel, setRiskLevel] = useState<RiskLevel>("balanced");
  const [stake, setStake] = useState(10);
  const [results, setResults] = useState<SmartPickResult[] | null>(null);
  const generateMutation = useGenerateSmartPicks();
  const { toast } = useToast();

  const handleGenerate = () => {
    generateMutation.mutate(
      { data: { riskLevel, stakeAmount: stake, count: 4 } },
      {
        onSuccess: (data) => {
          setResults(data.combos);
          if (data.combos.length === 0) {
            toast({
              title: "No combos found",
              description: "Not enough markets matched your risk level. Try a different setting.",
              variant: "destructive",
            });
          }
        },
        onError: () => {
          toast({ title: "Generation failed", description: "Could not fetch live market data. Try again.", variant: "destructive" });
        },
      },
    );
  };

  const selectedRiskOption = RISK_OPTIONS.find((o) => o.value === riskLevel)!;
  const isLoading = generateMutation.isPending;

  return (
    <div className="flex flex-col h-[100dvh] overflow-hidden">
      {/* Top controls */}
      <div className="border-b border-border bg-card/50 p-6 flex-shrink-0">
        <div className="max-w-4xl mx-auto">
          <div className="flex items-center gap-2 mb-1">
            <Sparkles className="w-5 h-5 text-primary" />
            <h1 className="text-xl font-bold">Smart Picks</h1>
          </div>
          <p className="text-sm text-muted-foreground mb-6">
            Auto-generate 4 non-overlapping combo parlays — one click, zero manual browsing.
          </p>

          <div className="flex flex-col sm:flex-row gap-6 items-start sm:items-end">
            {/* Stake input */}
            <div className="space-y-1.5 w-full sm:w-48">
              <label className="text-sm font-medium">Stake per combo ($)</label>
              <Input
                type="number"
                min={1}
                max={10000}
                value={stake}
                onChange={(e) => setStake(Math.max(1, Number(e.target.value) || 1))}
                className="font-mono"
                data-testid="input-stake"
              />
            </div>

            {/* Risk level */}
            <div className="space-y-1.5 flex-1">
              <label className="text-sm font-medium">Risk appetite</label>
              <div className="flex gap-2 flex-wrap">
                {RISK_OPTIONS.map((opt) => {
                  const Icon = opt.icon;
                  const active = riskLevel === opt.value;
                  return (
                    <button
                      key={opt.value}
                      onClick={() => setRiskLevel(opt.value)}
                      data-testid={`risk-${opt.value}`}
                      className={`flex items-center gap-2 px-4 py-2 rounded-lg border text-sm font-medium transition-all ${
                        active
                          ? opt.color
                          : "border-border text-muted-foreground hover:border-border/80 hover:text-foreground"
                      }`}
                    >
                      <Icon className="w-4 h-4" />
                      {opt.label}
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">{selectedRiskOption.description}</p>
            </div>

            {/* Generate button */}
            <Button
              size="lg"
              className="h-11 px-8 flex-shrink-0"
              onClick={handleGenerate}
              disabled={isLoading}
              data-testid="button-generate-picks"
            >
              {isLoading ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Sparkles className="w-4 h-4 mr-2" />
              )}
              Generate 4 Best Combos
            </Button>
          </div>
        </div>
      </div>

      {/* Results */}
      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-4xl mx-auto space-y-6">
          {/* Skeleton loaders */}
          {isLoading && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {[0, 1, 2, 3].map((i) => <ComboCardSkeleton key={i} />)}
            </div>
          )}

          {/* Empty state (before first generate) */}
          {!isLoading && results === null && (
            <div className="flex flex-col items-center justify-center py-24 text-center text-muted-foreground space-y-4">
              <Sparkles className="w-14 h-14 opacity-20" />
              <div>
                <p className="font-medium text-foreground">No picks generated yet</p>
                <p className="text-sm mt-1">Choose your stake and risk level, then click "Generate 4 Best Combos".</p>
              </div>
            </div>
          )}

          {/* No results after generate */}
          {!isLoading && results !== null && results.length === 0 && (
            <div className="flex flex-col items-center justify-center py-24 text-center text-muted-foreground space-y-4">
              <Sparkles className="w-14 h-14 opacity-20" />
              <div>
                <p className="font-medium text-foreground">Not enough markets for this risk level</p>
                <p className="text-sm mt-1">Try switching to Balanced or Aggressive — more markets will match.</p>
              </div>
            </div>
          )}

          {/* Combo grid */}
          {!isLoading && results && results.length > 0 && (
            <>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {results.map((combo, i) => (
                  <SmartPickCard key={i} combo={combo} index={i} stake={stake} />
                ))}
              </div>

              {/* Non-overlap guarantee */}
              <div className="flex items-start gap-2.5 rounded-lg border border-border/50 bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
                <Info className="w-4 h-4 mt-0.5 shrink-0 text-primary/70" />
                <span>
                  <span className="font-medium text-foreground">Each combo uses different markets</span> — one loss won't affect the other three. Each can succeed or fail independently.
                </span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
