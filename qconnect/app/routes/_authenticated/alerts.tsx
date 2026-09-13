// Alerts screen — drop into src/routes/_authenticated/alerts.tsx of the
// QConnect Fleet Manager app. Shows everything the background workers have
// flagged, newest first, with one-click acknowledge and resolve.
import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { acknowledgeAlert, listAlerts, type FleetAlert } from "@/lib/qconnect-ops.functions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/alerts")({
  component: AlertsPage,
  head: () => ({
    meta: [
      { title: "Alerts — QConnect Fleet Manager" },
      {
        name: "description",
        content: "Every box that is stuck, silent or failing an update, in one list.",
      },
      { property: "og:title", content: "Alerts — QConnect Fleet Manager" },
      {
        property: "og:description",
        content: "Every box that is stuck, silent or failing an update, in one list.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

const KIND_LABELS: Record<string, string> = {
  step_overdue: "Setup step overdue",
  step_failed: "Setup step failed",
  device_silent: "Box has gone quiet",
  command_expired: "Instruction not carried out",
  update_failed: "Update did not take",
};

const formatDateTime = (value: string): string => {
  const date = new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const severityVariant = (severity: FleetAlert["severity"]) =>
  severity === "critical" ? "destructive" : severity === "warning" ? "default" : "secondary";

function AlertsPage() {
  const queryClient = useQueryClient();
  const [includeResolved, setIncludeResolved] = useState(false);

  const fetchAlerts = useServerFn(listAlerts);
  const acknowledge = useServerFn(acknowledgeAlert);

  const alerts = useQuery({
    queryKey: ["qconnect", "alerts", includeResolved],
    queryFn: () => fetchAlerts({ data: { includeResolved } }),
    refetchInterval: 30_000,
  });

  const act = useMutation({
    mutationFn: (vars: { alertId: string; resolve: boolean }) => acknowledge({ data: vars }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["qconnect", "alerts"] });
      toast.success("Alert updated");
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const openCount = (alerts.data ?? []).filter((alert) => alert.resolved_at === null).length;

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Alerts</h1>
          <p className="text-muted-foreground text-sm">
            {openCount === 0 ? "Nothing needs attention right now." : `${openCount} open`}
          </p>
        </div>
        <Button variant="outline" onClick={() => setIncludeResolved((value) => !value)}>
          {includeResolved ? "Hide resolved" : "Show resolved"}
        </Button>
      </header>

      {alerts.isLoading ? <p className="text-muted-foreground text-sm">Loading alerts…</p> : null}
      {alerts.isError ? (
        <p className="text-destructive text-sm">{(alerts.error as Error).message}</p>
      ) : null}

      <div className="space-y-3">
        {(alerts.data ?? []).map((alert) => (
          <Card key={alert.id} className={alert.resolved_at ? "opacity-60" : undefined}>
            <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
              <div className="space-y-1">
                <CardTitle className="text-base">{alert.title}</CardTitle>
                <p className="text-muted-foreground text-xs">
                  {alert.device_id ?? "Fleet"} · {formatDateTime(alert.opened_at)}
                  {alert.occurrences > 1 ? ` · seen ${alert.occurrences} times` : ""}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Badge variant={severityVariant(alert.severity)}>
                  {KIND_LABELS[alert.kind] ?? alert.kind}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm">{alert.detail ?? "No further detail was recorded."}</p>
              {alert.resolved_at ? (
                <span className="text-muted-foreground text-xs">
                  Resolved {formatDateTime(alert.resolved_at)}
                </span>
              ) : (
                <div className="flex shrink-0 gap-2">
                  {alert.acknowledged_at === null ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={act.isPending}
                      onClick={() => act.mutate({ alertId: alert.id, resolve: false })}
                    >
                      Acknowledge
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    disabled={act.isPending}
                    onClick={() => act.mutate({ alertId: alert.id, resolve: true })}
                  >
                    Resolve
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {!alerts.isLoading && (alerts.data ?? []).length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No alerts. Every box is checking in and clearing its setup steps.
        </p>
      ) : null}
    </div>
  );
}
