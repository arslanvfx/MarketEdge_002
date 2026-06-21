import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Sparkles, Loader2, Save, ShieldCheck, Zap, Flame, Info,
  Brain, TrendingUp, Clock, Search, Check, ChevronsUpDown, Trophy,
} from "lucide-react";
import {
  useGenerateSmartPicks,
  useSaveCombo,
  useListSmartPickCategories,
  SmartPickResult,
  SmartPicksInputRiskLevel,
  SmartPicksInputPlatform,
  SmartPicksInputLegCount,
  SmartPicksInputHorizon,
  getListCombosQueryKey,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Show } from "@clerk/react";

type RiskLevel = SmartPicksInputRiskLevel;

const RISK_OPTIONS: { value: RiskLevel; label: string; description: string; icon: React.ElementType; color: string }[] = [
  { value: "conservative", label: "Conservative", description: "High-probability legs, modest payouts", icon: ShieldCheck, color: "text-emerald-400 border-emerald-500/40 bg-emerald-500/10" },
  { value: "balanced",     label: "Balanced",     description: "Mix of probability and upside",        icon: Zap,        color: "text-sky-400 border-sky-500/40 bg-sky-500/10"           },
  { value: "aggressive",   label: "Aggressive",   description: "Lower-probability, bigger upside",     icon: Flame,      color: "text-orange-400 border-orange-500/40 bg-orange-500/10"  },
];

const RISK_SCORE_BADGE: Record<SmartPickResult["riskScore"], { label: string; className: string }> = {
  low:    { label: "Low Risk",  className: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" },
  medium: { label: "Med Risk",  className: "bg-amber-500/10 text-amber-400 border-amber-500/20"       },
  high:   { label: "High Risk", className: "bg-red-500/10 text-red-400 border-red-500/20"             },
};

type PlatformFilter = SmartPicksInputPlatform;
const PLATFORM_OPTIONS: { value: PlatformFilter; label: string }[] = [
  { value: "both",       label: "Both"       },
  { value: "polymarket", label: "Polymarket" },
  { value: "kalshi",     label: "Kalshi"     },
];

const PLATFORM_BADGE: Record<string, { label: string; className: string }> = {
  polymarket: { label: "Polymarket", className: "bg-violet-500/10 text-violet-400 border-violet-500/20" },
  kalshi:     { label: "Kalshi",     className: "bg-cyan-500/10 text-cyan-400 border-cyan-500/20"       },
};

type LegCount = SmartPicksInputLegCount;
const LEG_COUNT_OPTIONS: { value: LegCount; label: string; description: string }[] = [
  { value: "auto", label: "Auto",   description: "Fewest legs for the best return" },
  { value: "1",    label: "Single", description: "Single bets only"                },
  { value: "2",    label: "≤2",     description: "At most 2 legs"                  },
  { value: "3",    label: "≤3",     description: "At most 3 legs"                  },
  { value: "4",    label: "≤4",     description: "At most 4 legs"                  },
  { value: "5",    label: "5+",     description: "5 or more legs (riskier)"        },
];

type Horizon = SmartPicksInputHorizon;
const HORIZON_OPTIONS: { value: Horizon; label: string }[] = [
  { value: "any",     label: "Any"      },
  { value: "week",    label: "1 week"   },
  { value: "month",   label: "1 month"  },
  { value: "quarter", label: "3 months" },
  { value: "year",    label: "1 year"   },
];

/**
 * Parse a Kalshi gameKey (e.g. "26JUN27COLPOR") into a human-readable "COL vs POR"
 * label shown above standalone prop legs (corners, totals, spreads) when there is
 * no sibling winner leg in the same combo that already names the match.
 *
 * Format: DD{MON}{YY}{TEAM1 3-char}{TEAM2 3-char+}
 * Examples: "26JUN27COLPOR" → "COL vs POR", "08JUL27URYCPV" → "URY vs CPV"
 */
function gameKeyToMatchLabel(gameKey: string | null | undefined): string | null {
  if (!gameKey) return null;
  const dateMatch = gameKey.match(/^\d{2}[A-Z]{3}\d{2}(.+)$/);
  if (!dateMatch) return null;
  const teams = dateMatch[1];
  if (teams.length < 4) return null; // need at least 2 chars per team
  const t1 = teams.slice(0, 3);
  const t2 = teams.slice(3);
  return t2 ? `${t1} vs ${t2}` : t1;
}

function formatResolveDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const days = Math.round((t - Date.now()) / (24 * 60 * 60 * 1000));
  const date = new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  if (days <= 0) return `resolves ${date}`;
  if (days < 1)  return `resolves today`;
  if (days <= 31) return `resolves in ${days}d · ${date}`;
  return `resolves in ~${Math.round(days / 30)}mo · ${date}`;
}

function formatProb(p: number) { return `${(p * 100).toFixed(1)}%`; }
function formatMult(m: number) { return `${m.toFixed(2)}×`; }
function formatPayout(n: number) {
  return n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toFixed(2)}`;
}
function formatEdgePts(edge: number) { return `+${(edge * 100).toFixed(0)} pts`; }

const CONFIDENCE_LABEL: Record<string, string> = {
  low: "Low confidence", medium: "Medium confidence", high: "High confidence",
};

function FilterChip({
  active, onClick, children, testId, color,
}: {
  active: boolean; onClick: () => void; children: React.ReactNode; testId?: string; color?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className={`px-3 py-1.5 rounded-lg border text-sm font-medium transition-all whitespace-nowrap ${
        active
          ? (color ?? "border-primary/40 bg-primary/10 text-primary")
          : "border-border text-muted-foreground hover:border-muted-foreground/40 hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function ComboCardSkeleton() {
  return (
    <Card className="p-5 space-y-4 animate-pulse">
      <div className="flex justify-between items-start">
        <Skeleton className="h-9 w-28" />
        <Skeleton className="h-6 w-20" />
      </div>
      <Skeleton className="h-px w-full" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
      <div className="flex justify-between pt-2">
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-9 w-28" />
      </div>
    </Card>
  );
}

interface SmartPickCardProps { combo: SmartPickResult; index: number; stake: number; }

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
        onError: () => toast({ title: "Save failed", variant: "destructive" }),
      },
    );
  };

  return (
    <Card className="overflow-hidden border-border/50 shadow-md flex flex-col">
      {/* Header */}
      <div className="bg-card px-5 py-4 border-b border-border/50 flex items-start justify-between gap-3">
        <div>
          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-0.5">
            {combo.legs.length === 1 ? `Single bet ${index + 1}` : `Combo ${index + 1} · ${combo.legs.length} legs`}
          </p>
          <div className="text-3xl font-bold font-mono text-primary leading-none mt-1">
            {formatMult(combo.payoutMultiplier)}
          </div>
        </div>
        <div className="text-right space-y-1 shrink-0">
          <Badge variant="outline" className={`text-xs ${badge.className}`}>{badge.label}</Badge>
          <div className="flex items-center justify-end gap-1.5 text-xs font-semibold text-emerald-400">
            <TrendingUp className="w-3.5 h-3.5" />
            +{combo.edgePercent.toFixed(0)}% edge
          </div>
          <div className="text-xs text-muted-foreground">{formatProb(combo.jointProbability)} win prob</div>
        </div>
      </div>

      {/* AI rationale */}
      <div className="px-5 py-3 bg-primary/[0.04] border-b border-border/50 flex items-start gap-2">
        <Brain className="w-4 h-4 mt-0.5 shrink-0 text-primary/80" />
        <p className="text-xs leading-snug text-muted-foreground">{combo.rationale}</p>
      </div>

      {/* Legs */}
      <div className="flex-1 divide-y divide-border/30">
        {combo.legs.map((leg, i) => {
          // For same-game prop legs (e.g. total goals), the marketTitle may not mention
          // which match — try to pull the game name from a sibling winner leg in this combo
          // that shares the same gameKey and contains "vs" in its title.
          const legGameKey = (leg as any).gameKey;
          const isWinnerLeg = leg.marketTitle.toLowerCase().includes(" vs ");
          // For same-game prop legs (corners, totals, spreads), try to pull the
          // matchup from a sibling winner leg in this combo with the same gameKey.
          // If no sibling winner exists (prop is the only leg from that game),
          // fall back to parsing the gameKey itself ("26JUN27COLPOR" → "COL vs POR").
          const gameContext = isWinnerLeg ? null :
            legGameKey
              ? (combo.legs.find(
                  (other) =>
                    other !== leg &&
                    (other as any).gameKey === legGameKey &&
                    other.marketTitle.toLowerCase().includes(" vs "),
                )?.marketTitle ?? gameKeyToMatchLabel(legGameKey))
              : null;

          return (
          <div key={i} className="px-4 py-3">
            <div className="flex items-start gap-3">
              <Badge
                variant="outline"
                className={
                  leg.position === "yes"
                    ? "bg-primary/10 text-primary border-primary/20 text-[10px] mt-0.5 shrink-0"
                    : "bg-destructive/10 text-destructive border-destructive/20 text-[10px] mt-0.5 shrink-0"
                }
              >
                {leg.position.toUpperCase()}
              </Badge>
              <div className="flex-1 min-w-0">
                {/* Game context — show the matchup for prop legs that don't have "vs" in title */}
                {gameContext && (
                  <div className="text-[10px] font-medium text-primary/70 uppercase tracking-wide mb-0.5">
                    {gameContext}
                  </div>
                )}
                <div className="text-xs leading-snug text-muted-foreground/90">{leg.marketTitle}</div>
                {leg.selection && (
                  <div className="font-semibold text-sm leading-snug mt-0.5">Pick: {leg.selection}</div>
                )}
                <div className="flex items-center gap-1 mt-1 flex-wrap">
                  {PLATFORM_BADGE[leg.platform] && (
                    <Badge variant="outline" className={`text-[9px] px-1.5 py-0 font-medium ${PLATFORM_BADGE[leg.platform].className}`}>
                      {PLATFORM_BADGE[leg.platform].label}
                    </Badge>
                  )}
                  {leg.legType && (
                    <Badge
                      variant="outline"
                      className={`text-[9px] px-1.5 py-0 font-medium ${
                        leg.legType === "value"
                          ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                          : "bg-sky-500/10 text-sky-400 border-sky-500/20"
                      }`}
                    >
                      {leg.legType === "value" ? "Value" : "Safe pick"}
                    </Badge>
                  )}
                </div>
                {leg.aiReasoning && (
                  <div className="flex items-start gap-1 mt-1 text-[11px] leading-snug text-muted-foreground">
                    <Brain className="w-3 h-3 mt-px shrink-0 text-primary/60" />
                    <span>
                      {leg.aiReasoning}
                      {leg.aiConfidence && (
                        <span className="opacity-60"> · {CONFIDENCE_LABEL[leg.aiConfidence] ?? leg.aiConfidence}</span>
                      )}
                    </span>
                  </div>
                )}
                {formatResolveDate(leg.closeTime) && (
                  <div className="flex items-center gap-1 mt-1 text-[11px] leading-snug text-muted-foreground">
                    <Clock className="w-3 h-3 shrink-0 text-muted-foreground/60" />
                    <span>{formatResolveDate(leg.closeTime)}</span>
                  </div>
                )}
              </div>
              <div className="text-right shrink-0 space-y-0.5">
                {typeof leg.edge === "number" && leg.legType !== "safe" && (
                  <Badge variant="outline" className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 text-[10px] font-mono">
                    {formatEdgePts(leg.edge)}
                  </Badge>
                )}
                <div className="font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                  mkt {formatProb(leg.impliedProb)}
                  {typeof leg.trueProbability === "number" && <> · AI {formatProb(leg.trueProbability)}</>}
                </div>
              </div>
            </div>
          </div>
          );
        })}
      </div>

      {/* Footer */}
      <div className="px-5 py-4 border-t border-border/50 bg-muted/20 flex items-center justify-between gap-3">
        <div className="text-sm">
          <div>
            <span className="text-muted-foreground">Est. payout </span>
            <span className="font-semibold text-primary font-mono">{formatPayout(estimatedPayout)}</span>
            <span className="text-muted-foreground text-xs"> on ${stake}</span>
          </div>
          <div className="text-xs mt-0.5">
            <span className="text-muted-foreground">Expected value </span>
            <span className={`font-mono font-semibold ${combo.expectedValue >= 0 ? "text-emerald-400" : "text-red-400"}`}>
              {combo.expectedValue >= 0 ? "+" : ""}{formatPayout(combo.expectedValue)}
            </span>
          </div>
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
              <DialogHeader><DialogTitle>Save Smart Pick</DialogTitle></DialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Name</label>
                  <Input
                    value={comboName}
                    onChange={(e) => setComboName(e.target.value)}
                    placeholder="Give this pick a name"
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

function CategoryPicker({
  categories, value, onChange,
}: {
  categories: { name: string; count: number; volume: number }[];
  value: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const trending = categories.slice(0, 5);

  return (
    <div className="space-y-2">
      <div className="flex gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => onChange("all")}
          data-testid="category-all"
          className={`px-3 py-1.5 rounded-full border text-xs font-medium transition-all ${
            value === "all"
              ? "border-primary/40 bg-primary/10 text-primary"
              : "border-border text-muted-foreground hover:border-muted-foreground/40 hover:text-foreground"
          }`}
        >
          All
        </button>
        <button
          type="button"
          onClick={() => onChange("Sports")}
          data-testid="category-sports"
          className={`flex items-center gap-1 px-3 py-1.5 rounded-full border text-xs font-medium transition-all ${
            value === "Sports"
              ? "border-primary/40 bg-primary/10 text-primary"
              : "border-border text-muted-foreground hover:border-muted-foreground/40 hover:text-foreground"
          }`}
        >
          <Trophy className="w-3 h-3" />
          Sports
        </button>
        {trending.map((cat) => {
          const active = value === cat.name;
          return (
            <button
              key={cat.name}
              type="button"
              onClick={() => onChange(cat.name)}
              data-testid={`category-${cat.name}`}
              className={`flex items-center gap-1 px-3 py-1.5 rounded-full border text-xs font-medium transition-all ${
                active
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:border-muted-foreground/40 hover:text-foreground"
              }`}
            >
              <Flame className="w-3 h-3 text-orange-400" />
              {cat.name}
            </button>
          );
        })}
      </div>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            data-testid="category-search-trigger"
            className="w-full justify-between font-normal"
          >
            <span className="flex items-center gap-2 truncate">
              <Search className="w-3.5 h-3.5 shrink-0 opacity-60" />
              <span className="truncate">{value === "all" ? "All categories" : value}</span>
            </span>
            <ChevronsUpDown className="w-3.5 h-3.5 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
          <Command>
            <CommandInput placeholder="Search categories…" data-testid="input-category-search" />
            <CommandList>
              <CommandEmpty>No categories found.</CommandEmpty>
              <CommandGroup>
                <CommandItem value="All categories" onSelect={() => { onChange("all"); setOpen(false); }} data-testid="category-option-all">
                  <Check className={`mr-2 h-4 w-4 ${value === "all" ? "opacity-100" : "opacity-0"}`} />
                  All categories
                </CommandItem>
                <CommandItem value="All Sports" onSelect={() => { onChange("Sports"); setOpen(false); }} data-testid="category-option-sports">
                  <Check className={`mr-2 h-4 w-4 ${value === "Sports" ? "opacity-100" : "opacity-0"}`} />
                  <Trophy className="mr-1 h-3.5 w-3.5 opacity-60" />
                  All Sports
                </CommandItem>
                {categories.map((cat) => (
                  <CommandItem key={cat.name} value={cat.name} onSelect={() => { onChange(cat.name); setOpen(false); }} data-testid={`category-option-${cat.name}`}>
                    <Check className={`mr-2 h-4 w-4 ${value === cat.name ? "opacity-100" : "opacity-0"}`} />
                    <span className="flex-1 truncate">{cat.name}</span>
                    <span className="ml-2 text-xs text-muted-foreground">{cat.count}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}

export default function SmartPicks() {
  const [riskLevel, setRiskLevel] = useState<RiskLevel>("balanced");
  const [platform, setPlatform] = useState<PlatformFilter>("both");
  const [category, setCategory] = useState<string>("all");
  const [legCount, setLegCount] = useState<LegCount>("auto");
  const [horizon, setHorizon] = useState<Horizon>("any");
  const [stake, setStake] = useState(10);
  const [results, setResults] = useState<SmartPickResult[] | null>(null);
  const generateMutation = useGenerateSmartPicks();
  const { data: categoriesData } = useListSmartPickCategories();
  const { toast } = useToast();

  const handleGenerate = () => {
    generateMutation.mutate(
      { data: { riskLevel, stakeAmount: stake, count: 4, platform, category, legCount, horizon } },
      {
        onSuccess: (data) => {
          setResults(data.combos);
          if (data.combos.length === 0) {
            const hints: string[] = [];
            if (category !== "all") hints.push(`the "${category}" category`);
            if (legCount !== "auto") {
              const legOpt = LEG_COUNT_OPTIONS.find((o) => o.value === legCount);
              if (legOpt) hints.push(`"${legOpt.label}" combo size`);
            }
            if (horizon !== "any") {
              const label = HORIZON_OPTIONS.find((h) => h.value === horizon)?.label ?? horizon;
              hints.push(`a ${label} resolution window`);
            }
            const scope = hints.length
              ? `Not enough qualifying legs right now for ${hints.join(" with ")}.`
              : "Not enough markets matched your settings right now.";
            toast({
              title: "No combos found",
              description: `${scope} Try "Any" timeframe, "All" categories, "Auto" combo size, or a different risk level.`,
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
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-4 py-6 space-y-6 pb-12">

        {/* Page header */}
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Sparkles className="w-5 h-5 text-primary" />
            <h1 className="text-xl font-bold">Smart Picks</h1>
          </div>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Claude analyzes live markets and surfaces mispriced{" "}
            <span className="text-emerald-400 font-medium">value</span> bets plus high-confidence{" "}
            <span className="text-sky-400 font-medium">safe</span> favorites. Kalshi picks include
            same-game combos; Polymarket shows the best single bets.
          </p>
        </div>

        {/* Settings card */}
        <Card className="overflow-hidden">
          <div className="px-5 py-4 border-b border-border/60 bg-muted/30">
            <p className="text-sm font-semibold">Pick settings</p>
          </div>
          <div className="px-5 py-5 space-y-5">

            {/* Stake */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">Stake per combo</label>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">$</span>
                  <input
                    type="number"
                    min={1}
                    max={10000}
                    value={stake}
                    onChange={(e) => setStake(Math.max(1, Number(e.target.value) || 1))}
                    data-testid="slider-stake"
                    className="w-20 text-right bg-transparent border border-border rounded-md px-2 py-1 text-sm font-mono font-semibold text-primary focus:outline-none focus:ring-1 focus:ring-primary/50"
                  />
                </div>
              </div>
            </div>

            {/* Risk + Platform */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              <div className="space-y-2">
                <label className="text-sm font-medium">Risk appetite</label>
                <div className="flex flex-wrap gap-2">
                  {RISK_OPTIONS.map((opt) => {
                    const Icon = opt.icon;
                    return (
                      <FilterChip
                        key={opt.value}
                        active={riskLevel === opt.value}
                        onClick={() => setRiskLevel(opt.value)}
                        testId={`risk-${opt.value}`}
                        color={opt.color}
                      >
                        <span className="flex items-center gap-1.5">
                          <Icon className="w-3.5 h-3.5" />
                          {opt.label}
                        </span>
                      </FilterChip>
                    );
                  })}
                </div>
                <p className="text-xs text-muted-foreground">{selectedRiskOption.description}</p>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Platform</label>
                <div className="flex flex-wrap gap-2">
                  {PLATFORM_OPTIONS.map((opt) => (
                    <FilterChip
                      key={opt.value}
                      active={platform === opt.value}
                      onClick={() => setPlatform(opt.value)}
                      testId={`platform-${opt.value}`}
                    >
                      {opt.label}
                    </FilterChip>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">Markets differ per platform</p>
              </div>
            </div>

            {/* Legs + Horizon */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              <div className="space-y-2">
                <label className="text-sm font-medium">Max combo size</label>
                <div className="flex flex-wrap gap-2">
                  {LEG_COUNT_OPTIONS.map((opt) => (
                    <FilterChip
                      key={opt.value}
                      active={legCount === opt.value}
                      onClick={() => setLegCount(opt.value)}
                      testId={`legcount-${opt.value}`}
                    >
                      {opt.label}
                    </FilterChip>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  {LEG_COUNT_OPTIONS.find((o) => o.value === legCount)?.description ?? "Fewest legs for the best return"}
                </p>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Resolves within</label>
                <div className="flex flex-wrap gap-2">
                  {HORIZON_OPTIONS.map((opt) => (
                    <FilterChip
                      key={opt.value}
                      active={horizon === opt.value}
                      onClick={() => setHorizon(opt.value)}
                      testId={`horizon-${opt.value}`}
                    >
                      {opt.label}
                    </FilterChip>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">Only bets settling within this window</p>
              </div>
            </div>

            {/* Category */}
            <div className="space-y-2">
              <label className="text-sm font-medium">Category</label>
              <CategoryPicker
                categories={categoriesData?.categories ?? []}
                value={category}
                onChange={setCategory}
              />
              <p className="text-xs text-muted-foreground">Search any topic or tap a trending one</p>
            </div>
          </div>

          {/* Generate button — inside the card, always reachable */}
          <div className="px-5 pb-5">
            <Button
              size="lg"
              className="w-full h-12 text-base font-semibold"
              onClick={handleGenerate}
              disabled={isLoading}
              data-testid="button-generate-picks"
            >
              {isLoading ? (
                <><Loader2 className="w-5 h-5 mr-2 animate-spin" /> Analyzing with AI…</>
              ) : (
                <><Sparkles className="w-5 h-5 mr-2" /> Find Best Picks</>
              )}
            </Button>
          </div>
        </Card>

        {/* Loading state */}
        {isLoading && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Brain className="w-4 h-4 text-primary animate-pulse" />
              <span>Claude is analyzing live markets…</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {[0, 1, 2, 3].map((i) => <ComboCardSkeleton key={i} />)}
            </div>
          </div>
        )}

        {/* Empty state — before first generate */}
        {!isLoading && results === null && (
          <div className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground space-y-3">
            <Sparkles className="w-12 h-12 opacity-15" />
            <div>
              <p className="font-medium text-foreground">No picks yet</p>
              <p className="text-sm mt-1">Set your preferences above and tap "Find Best Picks".</p>
            </div>
          </div>
        )}

        {/* Empty result after generate */}
        {!isLoading && results !== null && results.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground space-y-3">
            <Info className="w-10 h-10 opacity-20" />
            <div>
              <p className="font-medium text-foreground">No picks found</p>
              <p className="text-sm mt-1">Try "All" categories, "Any" timeframe, or a different risk level.</p>
            </div>
          </div>
        )}

        {/* Results grid */}
        {!isLoading && results && results.length > 0 && (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-primary" />
              <h2 className="text-sm font-semibold">{results.length} pick{results.length !== 1 ? "s" : ""} found</h2>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {results.map((combo, i) => (
                <SmartPickCard key={i} combo={combo} index={i} stake={stake} />
              ))}
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
