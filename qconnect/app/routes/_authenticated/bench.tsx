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
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

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
