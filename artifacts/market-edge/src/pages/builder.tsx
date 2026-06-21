import { useState } from "react";
import { useBuilder } from "@/lib/builder-context";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useOptimizeCombos, useSaveCombo, OptimizeLegInputPlatform, OptimizeLegInputPosition, getListCombosQueryKey, ComboSuggestion } from "@workspace/api-client-react";
import { X, Target, Zap, AlertTriangle, Save, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Skeleton } from "@/components/ui/skeleton";

function formatMultiplier(mult: number) {
  return `${mult.toFixed(2)}x`;
}

function formatProb(prob: number) {
  return `${(prob * 100).toFixed(1)}%`;
}

export default function Builder() {
  const { selectedLegs, removeLeg, updateLegPosition, clearLegs } = useBuilder();
  const [results, setResults] = useState<ComboSuggestion[]>([]);
  const [comboName, setComboName] = useState("");
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [selectedResultToSave, setSelectedResultToSave] = useState<ComboSuggestion | null>(null);
  
  const optimizeMutation = useOptimizeCombos();
  const saveMutation = useSaveCombo();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();

  const handleOptimize = () => {
    if (selectedLegs.length < 2) {
      toast({ title: "Need more markets", description: "Select at least 2 markets to optimize combos.", variant: "destructive" });
      return;
    }

    optimizeMutation.mutate(
      {
        data: {
          legs: selectedLegs.map(leg => ({
            marketId: leg.market.id,
            platform: leg.market.platform as OptimizeLegInputPlatform,
            position: leg.position as OptimizeLegInputPosition
          })),
          maxComboSize: 5,
          topN: 10
        }
      },
      {
        onSuccess: (data) => {
          setResults(data.combos);
          if (data.combos.length === 0) {
            toast({ title: "No valid combos", description: "Could not find any valid combinations for these markets." });
          } else {
            toast({ title: "Optimization Complete", description: `Found ${data.combos.length} potential combos.` });
          }
        },
        onError: () => {
          toast({ title: "Optimization Failed", description: "There was an error optimizing your combos.", variant: "destructive" });
        }
      }
    );
  };

  const handleSave = () => {
    if (!selectedResultToSave || !comboName) return;

    saveMutation.mutate(
      {
        data: {
          name: comboName,
          legs: selectedResultToSave.legs.map(leg => ({
            marketId: leg.marketId,
            platform: leg.platform as any,
            marketTitle: leg.marketTitle,
            position: leg.position as any,
            oddsAtSave: leg.odds,
            impliedProbAtSave: leg.impliedProb
          }))
        }
      },
      {
        onSuccess: () => {
          toast({ title: "Combo Saved", description: "Your combo has been saved to your portfolio." });
          setSaveDialogOpen(false);
          setComboName("");
          queryClient.invalidateQueries({ queryKey: getListCombosQueryKey() });
          setLocation("/portfolio");
        },
        onError: () => {
          toast({ title: "Failed to save", description: "There was an error saving your combo.", variant: "destructive" });
        }
      }
    );
  };

  return (
    <div className="flex h-[100dvh] flex-col md:flex-row overflow-hidden">
      {/* Left Panel: Selected Markets */}
      <div className="w-full md:w-1/2 lg:w-2/5 flex flex-col border-b md:border-b-0 md:border-r border-border bg-card/30">
        <div className="p-6 border-b border-border bg-card/50 flex justify-between items-center">
          <div>
            <h2 className="text-xl font-bold flex items-center gap-2">
              <Target className="w-5 h-5 text-primary" /> Builder
            </h2>
            <p className="text-sm text-muted-foreground mt-1">Select positions for your combination</p>
          </div>
          {selectedLegs.length > 0 && (
            <Button variant="ghost" size="sm" onClick={clearLegs} data-testid="button-clear-legs">Clear</Button>
          )}
        </div>

        <div className="flex-1 overflow-auto p-6 space-y-4">
          {selectedLegs.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center p-8 border-2 border-dashed border-border rounded-xl">
              <Target className="w-12 h-12 text-muted-foreground/50 mb-4" />
              <h3 className="font-semibold text-lg">No markets selected</h3>
              <p className="text-muted-foreground text-sm mt-2 mb-4">Go to the market browser to add some legs to your combo.</p>
              <Button onClick={() => setLocation("/markets")} variant="outline" data-testid="button-go-markets">Browse Markets</Button>
            </div>
          ) : (
            selectedLegs.map((leg, index) => (
              <Card key={`${leg.market.id}-${index}`} className="p-4 bg-card relative group">
                <Button 
                  variant="ghost" 
                  size="icon" 
                  className="absolute right-2 top-2 h-6 w-6 opacity-50 hover:opacity-100" 
                  onClick={() => removeLeg(leg.market.id)}
                  data-testid={`button-remove-${leg.market.id}`}
                >
                  <X className="w-4 h-4" />
                </Button>
                
                <Badge variant="outline" className="mb-2 uppercase text-[10px]">{leg.market.platform}</Badge>
                <h4 className="font-medium text-sm leading-tight pr-6 mb-4">{leg.market.title}</h4>
                
                <div className="flex items-center justify-between">
                  <div className="text-sm">
                    <span className="text-muted-foreground">Odds: </span>
                    <span className="font-mono font-medium text-primary">
                      {formatProb(leg.position === "yes" ? leg.market.yesOdds : leg.market.noOdds)}
                    </span>
                  </div>
                  
                  <ToggleGroup 
                    type="single" 
                    value={leg.position} 
                    onValueChange={(val) => val && updateLegPosition(leg.market.id, val as "yes" | "no")}
                    className="scale-90 origin-right"
                    data-testid={`toggle-position-${leg.market.id}`}
                  >
                    <ToggleGroupItem value="yes" className="data-[state=on]:bg-primary/20 data-[state=on]:text-primary">YES</ToggleGroupItem>
                    <ToggleGroupItem value="no" className="data-[state=on]:bg-destructive/20 data-[state=on]:text-destructive">NO</ToggleGroupItem>
                  </ToggleGroup>
                </div>
              </Card>
            ))
          )}
        </div>

        <div className="p-6 border-t border-border bg-card/50">
          <Button 
            className="w-full h-12 text-lg" 
            size="lg" 
            disabled={selectedLegs.length < 2 || optimizeMutation.isPending}
            onClick={handleOptimize}
            data-testid="button-optimize"
          >
            {optimizeMutation.isPending ? (
              <Loader2 className="w-5 h-5 mr-2 animate-spin" />
            ) : (
              <Zap className="w-5 h-5 mr-2" />
            )}
            Optimize Combos
          </Button>
          {selectedLegs.length < 2 && (
            <p className="text-xs text-center text-muted-foreground mt-2">Select at least 2 markets</p>
          )}
        </div>
      </div>

      {/* Right Panel: Optimizer Results */}
      <div className="w-full md:w-1/2 lg:w-3/5 bg-background flex flex-col">
        <div className="p-6 border-b border-border">
          <h2 className="text-xl font-bold flex items-center gap-2">
            <Zap className="w-5 h-5 text-amber-500" /> Suggestions
          </h2>
          <p className="text-sm text-muted-foreground mt-1">Ranked by highest payout multiplier</p>
        </div>

        <div className="flex-1 overflow-auto p-6 space-y-6">
          {optimizeMutation.isPending ? (
            <div className="space-y-4">
              {[1, 2, 3].map(i => (
                <Card key={i} className="p-6 space-y-4">
                  <div className="flex justify-between"><Skeleton className="h-8 w-24" /><Skeleton className="h-8 w-32" /></div>
                  <Skeleton className="h-px w-full" />
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-12 w-full" />
                </Card>
              ))}
            </div>
          ) : results.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center text-muted-foreground p-8">
              <Zap className="w-12 h-12 mb-4 opacity-20" />
              <p>Run the optimizer to see combo suggestions.</p>
            </div>
          ) : (
            results.map((result, idx) => (
              <Card key={idx} className="overflow-hidden border-border/50 shadow-lg">
                <div className="bg-card p-4 md:p-6 flex flex-wrap gap-4 items-center justify-between border-b border-border/50">
                  <div>
                    <p className="text-sm text-muted-foreground uppercase tracking-wider mb-1">Payout Multiplier</p>
                    <div className="text-3xl font-bold font-mono text-primary flex items-center gap-2">
                      {formatMultiplier(result.payoutMultiplier)}
                      <span className="text-sm font-normal text-muted-foreground bg-muted px-2 py-1 rounded">
                        {formatProb(result.jointProbability)} prob
                      </span>
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-4">
                    {result.diversificationWarning && (
                      <Badge variant="outline" className="bg-amber-500/10 text-amber-500 border-amber-500/20 py-1.5 px-3">
                        <AlertTriangle className="w-4 h-4 mr-1.5" /> High Correlation
                      </Badge>
                    )}
                    
                    <Dialog open={saveDialogOpen && selectedResultToSave === result} onOpenChange={(open) => {
                      setSaveDialogOpen(open);
                      if (open) setSelectedResultToSave(result);
                    }}>
                      <DialogTrigger asChild>
                        <Button data-testid={`button-save-combo-${idx}`}>
                          <Save className="w-4 h-4 mr-2" /> Save Combo
                        </Button>
                      </DialogTrigger>
                      <DialogContent className="sm:max-w-md">
                        <DialogHeader>
                          <DialogTitle>Save Combo</DialogTitle>
                        </DialogHeader>
                        <div className="space-y-4 py-4">
                          <div className="space-y-2">
                            <label className="text-sm font-medium">Combo Name</label>
                            <Input 
                              placeholder="e.g. Fed Rate Cut + Crypto Bull" 
                              value={comboName}
                              onChange={(e) => setComboName(e.target.value)}
                              autoFocus
                              data-testid="input-combo-name"
                            />
                          </div>
                          
                          <div className="bg-muted/50 p-4 rounded-lg space-y-2 mt-4">
                            <div className="flex justify-between text-sm">
                              <span className="text-muted-foreground">Legs</span>
                              <span className="font-medium">{result.legs.length}</span>
                            </div>
                            <div className="flex justify-between text-sm">
                              <span className="text-muted-foreground">Multiplier</span>
                              <span className="font-medium text-primary font-mono">{formatMultiplier(result.payoutMultiplier)}</span>
                            </div>
                          </div>
                          
                          <Button 
                            className="w-full mt-4" 
                            onClick={handleSave} 
                            disabled={!comboName || saveMutation.isPending}
                            data-testid="button-confirm-save"
                          >
                            {saveMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                            Confirm Save
                          </Button>
                        </div>
                      </DialogContent>
                    </Dialog>
                  </div>
                </div>
                
                <div className="p-0">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/30">
                      <tr>
                        <th className="px-4 md:px-6 py-3 text-left font-medium text-muted-foreground w-16">Pos</th>
                        <th className="px-4 md:px-6 py-3 text-left font-medium text-muted-foreground">Market</th>
                        <th className="px-4 md:px-6 py-3 text-right font-medium text-muted-foreground w-24">Odds</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/30">
                      {result.legs.map((leg, lIdx) => (
                        <tr key={lIdx} className="hover:bg-muted/20">
                          <td className="px-4 md:px-6 py-4">
                            <Badge variant="outline" className={leg.position === "yes" ? "bg-primary/10 text-primary border-primary/20" : "bg-destructive/10 text-destructive border-destructive/20"}>
                              {leg.position.toUpperCase()}
                            </Badge>
                          </td>
                          <td className="px-4 md:px-6 py-4 font-medium max-w-[200px] truncate md:whitespace-normal">{leg.marketTitle}</td>
                          <td className="px-4 md:px-6 py-4 text-right font-mono">{formatProb(leg.impliedProb)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
