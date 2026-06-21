import { useState } from "react";
import { Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useCreateAlert, getListAlertsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

interface SetAlertDialogProps {
  market: {
    id: string;
    platform: string;
    title: string;
    yesOdds: number;
  };
}

export function SetAlertDialog({ market }: SetAlertDialogProps) {
  const [open, setOpen] = useState(false);
  const [condition, setCondition] = useState<"above" | "below">("above");
  const [thresholdInput, setThresholdInput] = useState(
    Math.round(market.yesOdds * 100).toString()
  );

  const createAlert = useCreateAlert();
  const qc = useQueryClient();
  const { toast } = useToast();

  const handleSubmit = () => {
    const pct = parseFloat(thresholdInput);
    if (isNaN(pct) || pct < 0 || pct > 100) {
      toast({
        title: "Invalid threshold",
        description: "Enter a number between 0 and 100.",
        variant: "destructive",
      });
      return;
    }

    createAlert.mutate(
      {
        data: {
          platform: market.platform as "kalshi" | "polymarket",
          marketId: market.id,
          marketTitle: market.title,
          condition,
          threshold: pct / 100,
        },
      },
      {
        onSuccess: () => {
          toast({
            title: "Alert Set",
            description: `You'll be notified when ${market.title} YES odds go ${condition} ${pct.toFixed(0)}%.`,
          });
          qc.invalidateQueries({ queryKey: getListAlertsQueryKey() });
          setOpen(false);
        },
        onError: () => {
          toast({
            title: "Error",
            description: "Failed to create alert. Make sure you're signed in.",
            variant: "destructive",
          });
        },
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-primary"
          data-testid={`button-set-alert-${market.id}`}
          title="Set price alert"
        >
          <Bell className="w-4 h-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Set Price Alert</DialogTitle>
          <DialogDescription className="line-clamp-2">
            {market.title}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>Current YES Odds</Label>
            <p className="text-2xl font-bold font-mono text-primary">
              {(market.yesOdds * 100).toFixed(1)}%
            </p>
          </div>

          <div className="space-y-2">
            <Label>Notify me when odds go</Label>
            <ToggleGroup
              type="single"
              value={condition}
              onValueChange={(v) => v && setCondition(v as "above" | "below")}
              className="justify-start"
            >
              <ToggleGroupItem value="above">Above</ToggleGroupItem>
              <ToggleGroupItem value="below">Below</ToggleGroupItem>
            </ToggleGroup>
          </div>

          <div className="space-y-2">
            <Label htmlFor="threshold">Threshold (%)</Label>
            <div className="flex items-center gap-2">
              <Input
                id="threshold"
                type="number"
                min={0}
                max={100}
                step={1}
                value={thresholdInput}
                onChange={(e) => setThresholdInput(e.target.value)}
                className="w-28"
                data-testid="input-alert-threshold"
              />
              <span className="text-muted-foreground">%</span>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={createAlert.isPending}
            data-testid="button-confirm-alert"
          >
            {createAlert.isPending ? "Saving…" : "Set Alert"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
