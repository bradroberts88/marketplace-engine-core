// Releases screen — drop into src/routes/_authenticated/releases.tsx of the
// QConnect Fleet Manager app. Publishes a signed software bundle and aims it
// at one box, one dealership or the whole fleet.
import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  listReleases,
  listRollouts,
  publishRelease,
  startRollout,
  stopRollout,
} from "@/lib/qconnect-ops.functions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/releases")({
  component: ReleasesPage,
  head: () => ({
    meta: [
      { title: "Software releases — QConnect Fleet Manager" },
      {
        name: "description",
        content: "Publish a signed box update and roll it out to part or all of the fleet.",
      },
      { property: "og:title", content: "Software releases — QConnect Fleet Manager" },
      {
        property: "og:description",
        content: "Publish a signed box update and roll it out to part or all of the fleet.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

const formatDate = (value: string): string => {
  const date = new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
};

function ReleasesPage() {
  const queryClient = useQueryClient();
  const [version, setVersion] = useState("");
  const [bundleUrl, setBundleUrl] = useState("");
  const [sha256, setSha256] = useState("");
  const [signature, setSignature] = useState("");
  const [notes, setNotes] = useState("");
  const [percent, setPercent] = useState("10");

  const fetchReleases = useServerFn(listReleases);
  const fetchRollouts = useServerFn(listRollouts);
  const publish = useServerFn(publishRelease);
  const start = useServerFn(startRollout);
  const stop = useServerFn(stopRollout);

  const releases = useQuery({ queryKey: ["qconnect", "releases"], queryFn: () => fetchReleases({}) });
  const rollouts = useQuery({ queryKey: ["qconnect", "rollouts"], queryFn: () => fetchRollouts({}) });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["qconnect", "releases"] });
    queryClient.invalidateQueries({ queryKey: ["qconnect", "rollouts"] });
  };

  const publishMutation = useMutation({
    mutationFn: () =>
      publish({
        data: {
          version,
          bundleUrl,
          sha256: sha256.trim().toLowerCase(),
          signature: signature.trim(),
          notes: notes || undefined,
          channel: "stable",
        },
      }),
    onSuccess: () => {
      toast.success(`Version ${version} published`);
      setSignature("");
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const rolloutMutation = useMutation({
    mutationFn: (vars: { version: string; percent: number }) =>
      start({ data: { version: vars.version, scopeKind: "all", percent: vars.percent } }),
    onSuccess: () => {
      toast.success("Rollout started");
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const stopMutation = useMutation({
    mutationFn: (releaseVersion: string) => stop({ data: { version: releaseVersion } }),
    onSuccess: () => {
      toast.success("Rollout stopped");
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const activeFor = (releaseVersion: string) =>
    (rollouts.data ?? []).find((rollout) => rollout.version === releaseVersion && rollout.active);

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold">Software releases</h1>
        <p className="text-muted-foreground text-sm">
          A box only installs a bundle whose fingerprint and signature both check out, and puts the
          old version back if the new one does not check in.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Publish a new version</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="version">Version</Label>
            <Input
              id="version"
              value={version}
              onChange={(event) => setVersion(event.target.value)}
              placeholder="2026.09.13-1"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="bundle">Bundle address</Label>
            <Input
              id="bundle"
              value={bundleUrl}
              onChange={(event) => setBundleUrl(event.target.value)}
              placeholder="https://…/qconnect-agent.tar.gz"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="sha">Fingerprint (SHA-256)</Label>
            <Input id="sha" value={sha256} onChange={(event) => setSha256(event.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="signature">Signature</Label>
            <Input
              id="signature"
              value={signature}
              onChange={(event) => setSignature(event.target.value)}
              placeholder="base64"
            />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="notes">What changed</Label>
            <Input id="notes" value={notes} onChange={(event) => setNotes(event.target.value)} />
          </div>
          <div className="sm:col-span-2">
            <Button
              disabled={publishMutation.isPending || version === "" || bundleUrl === ""}
              onClick={() => publishMutation.mutate()}
            >
              Publish version
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Published versions</CardTitle>
          <div className="flex items-center gap-2">
            <Label htmlFor="percent" className="text-xs">
              Rollout share
            </Label>
            <Input
              id="percent"
              className="w-20"
              value={percent}
              onChange={(event) => setPercent(event.target.value)}
            />
            <span className="text-muted-foreground text-xs">%</span>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {(releases.data ?? []).map((release) => {
            const active = activeFor(release.version);
            return (
              <div
                key={release.version}
                className="flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{release.version}</span>
                    {active ? (
                      <Badge>Rolling out to {active.percent}%</Badge>
                    ) : (
                      <Badge variant="secondary">Not rolling out</Badge>
                    )}
                  </div>
                  <p className="text-muted-foreground text-xs">
                    Published {formatDate(release.created_at)} · {release.notes ?? "No notes"}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  {active ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={stopMutation.isPending}
                      onClick={() => stopMutation.mutate(release.version)}
                    >
                      Stop rollout
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      disabled={rolloutMutation.isPending}
                      onClick={() =>
                        rolloutMutation.mutate({
                          version: release.version,
                          percent: Math.min(100, Math.max(1, Number(percent) || 10)),
                        })
                      }
                    >
                      Start rollout
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
          {!releases.isLoading && (releases.data ?? []).length === 0 ? (
            <p className="text-muted-foreground text-sm">No versions published yet.</p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
