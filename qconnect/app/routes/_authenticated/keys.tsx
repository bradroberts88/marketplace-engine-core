// Key rotation screen — drop into src/routes/_authenticated/keys.tsx of the
// QConnect Fleet Manager app. One remote-access key per card: this is where an
// operator sees which key went onto which box, how long it has left, and
// retires one that should no longer work.
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listCardKeys, revokeCardKey, type CardKey } from "@/lib/qconnect-ops.functions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/keys")({
  component: KeysPage,
  head: () => ({
    meta: [
      { title: "Card keys — QConnect Fleet Manager" },
      {
        name: "description",
        content:
          "Every box joins with its own remote-access key. See which key is on which card, how long it has left, and retire one.",
      },
      { property: "og:title", content: "Card keys — QConnect Fleet Manager" },
      {
        property: "og:description",
        content:
          "Every box joins with its own remote-access key. See which key is on which card, how long it has left, and retire one.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

const formatDate = (value: string | null): string => {
  if (!value) return "—";
  const date = new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
};

const stateBadge = (key: CardKey) => {
  switch (key.key_state) {
    case "expired":
      return <Badge variant="destructive">Expired</Badge>;
    case "expiring soon":
      return <Badge variant="destructive">Expires in {key.days_left ?? 0} days</Badge>;
    case "revoked":
      return <Badge variant="secondary">Retired</Badge>;
    case "unrecorded":
      return <Badge variant="outline">Key not recorded</Badge>;
    case "no expiry recorded":
      return <Badge variant="outline">No end date</Badge>;
    default:
      return <Badge>Good for {key.days_left ?? 0} days</Badge>;
  }
};

function KeysPage() {
  const queryClient = useQueryClient();
  const fetchKeys = useServerFn(listCardKeys);
  const revoke = useServerFn(revokeCardKey);

  const keys = useQuery({ queryKey: ["qconnect", "keys"], queryFn: () => fetchKeys({}) });

  const revokeMutation = useMutation({
    mutationFn: (deviceId: string) => revoke({ data: { deviceId } }),
    onSuccess: () => {
      toast.success("Key retired. Rewrite that card with a fresh one before shipping it.");
      queryClient.invalidateQueries({ queryKey: ["qconnect", "keys"] });
      queryClient.invalidateQueries({ queryKey: ["qconnect", "alerts"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const list = keys.data ?? [];
  const needsAttention = list.filter(
    (key) => key.key_state === "expired" || key.key_state === "expiring soon",
  );

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold">Card keys</h1>
        <p className="text-muted-foreground text-sm">
          Each card is written with its own key, so retiring one box never takes any other box off
          the air. A key within a fortnight of running out is flagged here and raises an alert,
          while there is still time to rewrite the card.
        </p>
      </header>

      {needsAttention.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {needsAttention.length} card{needsAttention.length === 1 ? "" : "s"} need attention
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground text-sm">
              {needsAttention.map((key) => key.device_id).join(", ")}
            </p>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Every card</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {list.map((key) => (
            <div
              key={key.device_id}
              className="flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{key.device_id}</span>
                  {stateBadge(key)}
                </div>
                <p className="text-muted-foreground text-xs">
                  {key.dealer_id ?? "No dealership"} · Written {formatDate(key.tailscale_key_issued_at)} ·
                  Runs out {formatDate(key.tailscale_key_expires_at)} ·
                  {key.tailscale_key_id ? ` Key ${key.tailscale_key_id}` : " Key id not recorded"}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={revokeMutation.isPending || key.key_state === "revoked"}
                  onClick={() => revokeMutation.mutate(key.device_id)}
                >
                  {key.key_state === "revoked" ? "Retired" : "Retire key"}
                </Button>
              </div>
            </div>
          ))}
          {!keys.isLoading && list.length === 0 ? (
            <p className="text-muted-foreground text-sm">No cards written yet.</p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
