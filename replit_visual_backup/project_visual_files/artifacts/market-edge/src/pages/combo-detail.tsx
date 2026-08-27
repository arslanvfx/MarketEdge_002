import { useGetCombo, getGetComboQueryKey } from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ArrowLeft, AlertTriangle, Calendar } from "lucide-react";
import { Link } from "wouter";
import { format } from "date-fns";

function formatMultiplier(mult: number) {
  return `${mult.toFixed(2)}x`;
}

function formatProb(prob: number) {
  return `${(prob * 100).toFixed(1)}%`;
}

export default function ComboDetail({ id }: { id: string }) {
  const { data: combo, isLoading, isError } = useGetCombo(id, {
    query: {
      enabled: !!id,
      queryKey: getGetComboQueryKey(id)
    }
  });

  if (isLoading) {
    return (
      <div className="p-6 md:p-8 max-w-5xl mx-auto w-full space-y-8">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-16 w-3/4" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (isError || !combo) {
    return (
      <div className="flex h-full items-center justify-center p-8 flex-col gap-4">
        <AlertTriangle className="w-12 h-12 text-destructive" />
        <h1 className="text-2xl font-bold">Combo not found</h1>
        <Link href="/portfolio">
          <Button variant="outline">Back to Portfolio</Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="p-6 md:p-8 max-w-5xl mx-auto w-full h-full overflow-y-auto">
      <Link href="/portfolio">
        <Button variant="ghost" size="sm" className="mb-6 -ml-3 text-muted-foreground" data-testid="button-back">
          <ArrowLeft className="w-4 h-4 mr-2" /> Back to Portfolio
        </Button>
      </Link>

      <div className="mb-8">
        <h1 className="text-4xl font-bold tracking-tight mb-2">{combo.name}</h1>
        <div className="flex items-center gap-4 text-sm text-muted-foreground">
          <span className="flex items-center"><Calendar className="w-4 h-4 mr-1" /> {format(new Date(combo.createdAt), "PPP")}</span>
          <span className="px-2 py-0.5 rounded-full bg-secondary text-secondary-foreground">{combo.legs.length} Legs</span>
        </div>
        {combo.note && <p className="mt-4 text-muted-foreground bg-muted/30 p-4 rounded-lg border border-border/50">{combo.note}</p>}
      </div>

      {combo.portfolioOverlapWarning && (
        <Alert variant="destructive" className="bg-destructive/10 border-destructive/20 text-destructive-foreground mb-8">
          <AlertTriangle className="h-5 w-5" />
          <AlertTitle className="text-lg font-semibold ml-2">Portfolio Overlap Warning</AlertTitle>
          <AlertDescription className="ml-2 mt-1">
            This combo shares an outcome that is present in <strong>every</strong> other combo in your portfolio. High risk of total portfolio wipeout if that outcome fails.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        <Card className="p-6 bg-card flex flex-col justify-center items-center text-center">
          <p className="text-sm text-muted-foreground uppercase tracking-wider mb-2">Locked Payout Multiplier</p>
          <div className="text-5xl font-bold font-mono text-primary">
            {formatMultiplier(combo.payoutMultiplierAtSave)}
          </div>
        </Card>
        
        <Card className="p-6 bg-card flex flex-col justify-center items-center text-center">
          <p className="text-sm text-muted-foreground uppercase tracking-wider mb-2">Joint Probability</p>
          <div className="text-5xl font-bold font-mono text-foreground">
            {formatProb(combo.jointProbabilityAtSave)}
          </div>
        </Card>
      </div>

      <h2 className="text-xl font-bold mb-4">Combo Legs</h2>
      <Card className="overflow-hidden border-border shadow-md">
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="bg-muted/40 text-muted-foreground text-xs uppercase tracking-wider">
              <tr>
                <th className="px-6 py-4 font-medium w-32">Platform</th>
                <th className="px-6 py-4 font-medium w-24">Pos</th>
                <th className="px-6 py-4 font-medium">Market Title</th>
                <th className="px-6 py-4 font-medium text-right w-32">Prob at Save</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/40">
              {combo.legs.map((leg) => (
                <tr key={leg.id} className="hover:bg-muted/20 transition-colors">
                  <td className="px-6 py-5">
                    <Badge variant="outline" className="uppercase text-[10px] bg-background">
                      {leg.platform}
                    </Badge>
                  </td>
                  <td className="px-6 py-5">
                    <Badge variant="outline" className={leg.position === "yes" ? "bg-primary/10 text-primary border-primary/20" : "bg-destructive/10 text-destructive border-destructive/20"}>
                      {leg.position.toUpperCase()}
                    </Badge>
                  </td>
                  <td className="px-6 py-5 font-medium text-base">
                    {leg.marketTitle}
                  </td>
                  <td className="px-6 py-5 text-right font-mono text-base">
                    {formatProb(leg.impliedProbAtSave)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
