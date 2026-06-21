import { useEffect, useRef } from "react";
import { useListAlerts, useDeleteAlert, getListAlertsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useUser } from "@clerk/react";

function AlertsNotifierInner() {
  const { data } = useListAlerts();
  const deleteAlert = useDeleteAlert();
  const qc = useQueryClient();
  const { toast } = useToast();
  const notifiedIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!data?.alerts) return;

    const triggered = data.alerts.filter(
      (a) => a.isTriggered && !notifiedIds.current.has(a.id)
    );

    for (const alert of triggered) {
      notifiedIds.current.add(alert.id);

      const pct = (alert.threshold * 100).toFixed(0);
      toast({
        title: "Price Alert Triggered! 🔔",
        description: `${alert.marketTitle} YES odds crossed ${alert.condition} ${pct}%.`,
        duration: 8000,
      });

      deleteAlert.mutate(
        { alertId: alert.id },
        {
          onSettled: () => {
            qc.invalidateQueries({ queryKey: getListAlertsQueryKey() });
          },
        }
      );
    }
  }, [data]);

  return null;
}

export function AlertsNotifier() {
  const { isSignedIn } = useUser();
  if (!isSignedIn) return null;
  return <AlertsNotifierInner />;
}
