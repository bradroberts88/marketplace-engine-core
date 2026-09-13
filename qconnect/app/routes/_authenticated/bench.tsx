// Bench test screen — drop into src/routes/_authenticated/bench.tsx of the
// QConnect Fleet Manager app. Records the 7-phase checklist per physical card
// and applies the go/no-go rule in the database, not on paper.
import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  finishBenchRun,
  listBenchChecks,
  recordBenchCheck,
  startBenchRun,
} from "@/lib/qconnect.functions";
import { listBatchConnectivity, type PathResult } from "@/lib/qconnect-ops.functions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

// Live batch tracker: the three ways a card can get online, filled in by the
// cards themselves as they report. Matches docs/PI-BATCH-TRACKER.md so the
// paper sheet and the screen say the same thing.
function PathCell({ result }: { result: PathResult | null }) {
  if (result === null) {
    return <span className="text-muted-foreground text-xs">not tried</span>;
  }
  return (
    <span
      className={
        result.ok
          ? "text-xs font-medium text-emerald-600"
          : "text-destructive text-xs font-medium"
      }
      title={result.detail ?? result.label}
    >
      {result.ok ? "Pass" : `Fail — ${result.label}`}
    </span>
  );
}

function BatchTracker() {
  const fetchBatch = useServerFn(listBatchConnectivity);
  const batch = useQuery({
    queryKey: ["qconnect", "batch-connectivity"],
    queryFn: () => fetchBatch(),
    refetchInterval: 60_000,
  });

  const cards = batch.data ?? [];
  const failing = cards.filter(
    (card) =>
      card.ethernet?.ok === false || card.wifi?.ok === false || card.cellular?.ok === false,
  ).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Batch tracker</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-muted-foreground text-sm">
          {cards.length} cards reporting, {failing} with a failed connection. This fills
          itself in as each card checks in.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-muted-foreground border-b text-left">
                <th className="py-2 pr-3 font-medium">Card</th>
                <th className="py-2 pr-3 font-medium">Cable</th>
                <th className="py-2 pr-3 font-medium">Wi-Fi</th>
                <th className="py-2 pr-3 font-medium">AT&amp;T SIM</th>
                <th className="py-2 font-medium">Now</th>
              </tr>
            </thead>
            <tbody>
              {cards.map((card) => (
                <tr key={card.device_id} className="border-b last:border-b-0">
                  <td className="py-2 pr-3 font-mono text-xs">{card.device_id}</td>
                  <td className="py-2 pr-3">
                    <PathCell result={card.ethernet} />
                  </td>
                  <td className="py-2 pr-3">
                    <PathCell result={card.wifi} />
                  </td>
                  <td className="py-2 pr-3">
                    <PathCell result={card.cellular} />
                  </td>
                  <td className="py-2 text-xs">
                    {card.online ? "Online" : card.health.replace(/_/g, " ")}
                  </td>
                </tr>
              ))}
              {cards.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-muted-foreground py-3 text-sm">
                    No card has reported a connection attempt yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

export const Route = createFileRoute("/_authenticated/bench")({
  component: BenchPage,
  head: () => ({
    meta: [
      { title: "Bench test — QConnect Fleet Manager" },
      {
        name: "description",
        content: "Record the seven-phase bench test before a card goes into production.",
      },
    ],
  }),
});

const PHASE_NAMES: Record<number, string> = {
  1: "Flash and provision",
  2: "First boot, happy path",
  3: "Reboot and power-cut resilience",
  4: "Setup hotspot fallback",
  5: "Remote control and kill switch",
  6: "Stolen-card simulation",
  7: "Burn-in",
};

function BenchPage() {
  const queryClient = useQueryClient();
  const [runId, setRunId] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState("QCN-TEST-001");
  const [operator, setOperator] = useState("");

  const start = useServerFn(startBenchRun);
  const finish = useServerFn(finishBenchRun);
  const fetchChecks = useServerFn(listBenchChecks);
  const record = useServerFn(recordBenchCheck);

  const checks = useQuery({
    queryKey: ["qconnect", "bench", runId],
    queryFn: () => fetchChecks({ data: { runId: runId as string } }),
    enabled: runId !== null,
  });

  const startRun = useMutation({
    mutationFn: () => start({ data: { deviceId, operator: operator || undefined } }),
    onSuccess: (result) => {
      setRunId(result.runId);
      toast.success(`Bench run opened for ${deviceId}`);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const mark = useMutation({
    mutationFn: (vars: { checkId: string; passed: boolean | null }) => record({ data: vars }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["qconnect", "bench", runId] }),
    onError: (error: Error) => toast.error(error.message),
  });

  const close = useMutation({
    mutationFn: () => finish({ data: { runId: runId as string } }),
    onSuccess: (result) =>
      result.verdict === "go"
        ? toast.success("Go for batch production.")
        : toast.warning("No-go: something failed or is still open."),
    onError: (error: Error) => toast.error(error.message),
  });

  const rows = checks.data ?? [];
  const done = rows.filter((row) => row.passed !== null).length;
  const failed = rows.filter((row) => row.passed === false).length;
  const phases = [...new Set(rows.map((row) => row.phase))];

  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Bench test</h1>
        <p className="text-muted-foreground text-sm">
          Prove one physical card end to end before producing a batch. Budget about two hours.
        </p>
      </header>

      {runId === null ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Open a run</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap items-end gap-3">
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">Device id</span>
              <Input value={deviceId} onChange={(event) => setDeviceId(event.target.value)} />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">Operator</span>
              <Input
                value={operator}
                placeholder="Your name"
                onChange={(event) => setOperator(event.target.value)}
              />
            </label>
            <Button onClick={() => startRun.mutate()} disabled={startRun.isPending}>
              Start run
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <p className="text-muted-foreground text-sm">
            {done} of {rows.length} steps recorded, {failed} failed.
          </p>
          {phases.map((phase) => (
            <Card key={phase}>
              <CardHeader>
                <CardTitle className="text-base">
                  Phase {phase} — {PHASE_NAMES[phase]}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {rows
                  .filter((row) => row.phase === phase)
                  .map((row) => (
                    <div
                      key={row.id}
                      className="flex items-start justify-between gap-4 border-b pb-2 text-sm last:border-b-0"
                    >
                      <span>
                        <span className="text-muted-foreground font-mono">{row.step}</span>{" "}
                        {row.label}
                      </span>
                      <span className="flex shrink-0 gap-1">
                        <Button
                          size="sm"
                          variant={row.passed === true ? "default" : "outline"}
                          onClick={() => mark.mutate({ checkId: row.id, passed: true })}
                        >
                          Pass
                        </Button>
                        <Button
                          size="sm"
                          variant={row.passed === false ? "destructive" : "outline"}
                          onClick={() => mark.mutate({ checkId: row.id, passed: false })}
                        >
                          Fail
                        </Button>
                      </span>
                    </div>
                  ))}
              </CardContent>
            </Card>
          ))}
          <Button onClick={() => close.mutate()} disabled={close.isPending}>
            Close run and get the verdict
          </Button>
        </>
      )}
    </main>
  );
}
