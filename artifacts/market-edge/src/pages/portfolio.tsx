import { useListCombos, getListCombosQueryKey, useDeleteCombo } from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle, Trash2, ChevronRight, Activity, Calendar } from "lucide-react";
import { Link } from "wouter";
import { format } from "date-fns";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

export default function Portfolio() {
  const { data, isLoading } = useListCombos();
  const deleteMutation = useDeleteCombo();
  const qc = useQueryClient();
  const { toast } = useToast();

  const handleDelete = (id: string, name: string) => {
    deleteMutation.mutate(
      { comboId: id },
      {
        onSuccess: () => {
          toast({ title: "Combo Deleted", description: `"${name}" has been removed from your portfolio.` });
          qc.invalidateQueries({ queryKey: getListCombosQueryKey() });
        },
        onError: () => {
          toast({ title: "Error", description: "Failed to delete combo.", variant: "destructive" });
        }
      }
    );
  };

  return (
    <div className="p-6 md:p-8 max-w-7xl mx-auto w-full h-full overflow-y-auto">
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">Portfolio</h1>
        <p className="text-muted-foreground mt-1">Track and manage your saved combinations.</p>
      </div>

      {isLoading ? (
        <div className="space-y-6">
          <Skeleton className="h-24 w-full" />
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
            {[1, 2, 3].map(i => <Skeleton key={i} className="h-64 w-full rounded-xl" />)}
          </div>
        </div>
      ) : !data || data.combos.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center border border-dashed border-border rounded-xl bg-card/30">
          <Activity className="w-12 h-12 text-muted-foreground mb-4 opacity-50" />
          <h3 className="text-xl font-semibold mb-2">Portfolio is Empty</h3>
          <p className="text-muted-foreground mb-6">You haven't saved any combos yet. Use the builder to find and save profitable combinations.</p>
          <Link href="/builder">
            <Button data-testid="button-go-builder">Go to Builder</Button>
          </Link>
        </div>
      ) : (
        <div className="space-y-8">
          {data.portfolioOverlapWarnings && data.portfolioOverlapWarnings.length > 0 && (
            <Alert variant="destructive" className="bg-destructive/10 border-destructive/20 text-destructive-foreground">
              <AlertTriangle className="h-5 w-5" />
              <AlertTitle className="text-lg font-semibold ml-2">Portfolio Exposure Warning</AlertTitle>
              <AlertDescription className="ml-2 mt-2">
                <p className="mb-2">The following positions appear in <strong>every</strong> saved combo. If they fail, your entire portfolio is compromised:</p>
                <ul className="list-disc list-inside space-y-1 ml-4 opacity-90 text-sm">
                  {data.portfolioOverlapWarnings.map((warn, i) => (
                    <li key={i} className="font-medium">
                      {warn.position.toUpperCase()} on "{warn.marketTitle}"
                    </li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
            {data.combos.map(combo => (
              <Card key={combo.id} className="flex flex-col overflow-hidden border-border/50 hover:border-primary/30 transition-colors group">
                <div className="p-5 border-b border-border/30 bg-card/50 flex justify-between items-start">
                  <div>
                    <h3 className="font-bold text-lg mb-1 line-clamp-2">{combo.name}</h3>
                    <div className="flex items-center text-xs text-muted-foreground">
                      <Calendar className="w-3 h-3 mr-1" />
                      {format(new Date(combo.createdAt), "MMM d, yyyy")}
                    </div>
                  </div>
                  
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity" data-testid={`button-delete-${combo.id}`}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Delete Combo?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This will permanently remove "{combo.name}" from your portfolio.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={() => handleDelete(combo.id, combo.name)} className="bg-destructive text-destructive-foreground hover:bg-destructive/90" data-testid="button-confirm-delete">Delete</AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
                
                <div className="p-5 flex-1 flex flex-col justify-between gap-6">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground uppercase tracking-wider">Legs</p>
                      <p className="font-medium text-lg">{combo.legs.length}</p>
                    </div>
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground uppercase tracking-wider">Implied Prob</p>
                      <p className="font-medium text-lg font-mono">{(combo.jointProbabilityAtSave * 100).toFixed(1)}%</p>
                    </div>
                  </div>
                  
                  <div className="bg-primary/5 p-4 rounded-lg border border-primary/10">
                    <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Payout Multiplier</p>
                    <p className="text-3xl font-bold font-mono text-primary">{combo.payoutMultiplierAtSave.toFixed(2)}x</p>
                  </div>
                  
                  <Link href={`/combo/${combo.id}`}>
                    <Button variant="outline" className="w-full justify-between group-hover:bg-primary group-hover:text-primary-foreground transition-colors" data-testid={`link-combo-${combo.id}`}>
                      View Details
                      <ChevronRight className="w-4 h-4" />
                    </Button>
                  </Link>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
