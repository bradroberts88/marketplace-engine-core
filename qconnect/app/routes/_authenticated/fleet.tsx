// Fleet screen — drop into src/routes/_authenticated/fleet.tsx of the
// QConnect Fleet Manager app. The pathless _authenticated layout already
// handles sign-in; the kill switch is re-checked in the database regardless.
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  listAudit,
  listFleet,
  setDeviceEnabled,
  type FleetDevice,
} from "@/lib/qconnect.functions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/fleet")({
  component: FleetPage,
  head: () => ({
    meta: [
      { title: "Fleet — QConnect Fleet Manager" },
      { name: "description", content: "Live status of every QConnect box in the field." },
    ],
  }),
});

const minutesSince = (iso: string | null) =>
  iso === null ? null : Math.round((Date.now() - new Date(iso).getTime()) / 60000);

// How the box reached the internet, in words a salesperson can repeat on the phone.
const pathLabel: Record<string, string> = {
  ethernet: "Network cable",
  wifi: "Wi-Fi",
  cellular: "Mobile data",
  hotspot: "Setup hotspot (waiting for details)",
  none: "No connection",
};

// The device reports machine-readable reasons; the dashboard is where they
// become an instruction rather than a riddle.
const errorLabel: Record<string, string> = {
  wrong_password: "Wi-Fi password is wrong",
  ssid_not_in_range: "That Wi-Fi network is not in range",
  ssid_not_in_range_2g_radio: "This box only sees 2.4 GHz networks; the Wi-Fi is 5 GHz",
  joined_but_no_internet: "Joined the Wi-Fi but there is no internet",
  captive_portal: "The network shows a sign-in page the box cannot complete",
  cellular_no_apn: "A modem is fitted but no APN was set",
  cellular_sim_locked: "The SIM is PIN-locked and needs unlocking",
  cellular_sim_disabled: "The SIM or modem radio is switched off; check the SIM is seated",
  cellular_no_tower: "The modem cannot see a tower; check the antenna and coverage",
  cellular_failed: "The mobile modem could not connect",
  netmanager_unavailable: "The network service on the box is not running",
  no_wifi_radio: "This box has no working Wi-Fi radio; use a cable or a modem",
  no_path: "No cable, Wi-Fi or mobile data available",
};

const healthLabel: Record<string, string> = {
  healthy: "Healthy",
  weak_signal: "Weak signal",
  offline: "Offline",
  disabled: "Disabled",
  never_checked_in: "Never checked in",
  stuck_network: "Cannot get online",
  stuck_tailscale: "Online, cannot join the private network",
  stuck_register: "Online, not registered",
};

const describe = (device: FleetDevice) => {
  const detail = device.last_error ? errorLabel[device.last_error] : undefined;
  return detail ?? healthLabel[device.health] ?? device.health;
};

function FleetPage() {
  const queryClient = useQueryClient();
  const fetchFleet = useServerFn(listFleet);
  const fetchAudit = useServerFn(listAudit);
  const toggle = useServerFn(setDeviceEnabled);

  const fleet = useQuery({
    queryKey: ["qconnect", "fleet"],
    queryFn: () => fetchFleet(),
    refetchInterval: 60_000,
  });
  const audit = useQuery({ queryKey: ["qconnect", "audit"], queryFn: () => fetchAudit() });

  const setEnabled = useMutation({
    mutationFn: (vars: { deviceId: string; enabled: boolean }) => toggle({ data: vars }),
    onSuccess: (result) => {
      toast.success(`${result.deviceId} ${result.enabled ? "enabled" : "disabled"}`);
      void queryClient.invalidateQueries({ queryKey: ["qconnect"] });
    },
    onError: (error: Error) =>
      toast.error(
        error.message.includes("not authorized")
          ? "Only an admin can switch a box on or off."
          : error.message,
      ),
  });

  const devices = fleet.data ?? [];
  const online = devices.filter((device) => device.online).length;

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Fleet</h1>
        <p className="text-muted-foreground text-sm">
          {devices.length} boxes registered, {online} reporting in the last 15 minutes.
        </p>
      </header>

      {fleet.isLoading ? <p className="text-muted-foreground text-sm">Loading fleet…</p> : null}
      {fleet.isError ? (
        <p className="text-destructive text-sm">Could not load the fleet. Try again shortly.</p>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {devices.map((device) => {
          const age = minutesSince(device.last_seen_at);
          const temp = device.last_status?.temp_c;
          return (
            <Card key={device.device_id}>
              <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
                <div>
                  <CardTitle className="font-mono text-base">{device.device_id}</CardTitle>
                  <p className="text-muted-foreground text-xs">{device.dealer_id}</p>
                </div>
                <Badge variant={device.online ? "default" : "destructive"}>
                  {device.online ? "Online" : "Offline"}
                </Badge>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {device.health !== "healthy" ? (
                  <p
                    className={
                      device.health === "disabled"
                        ? "text-muted-foreground"
                        : "text-destructive font-medium"
                    }
                  >
                    {describe(device)}
                  </p>
                ) : null}
                <dl className="grid grid-cols-2 gap-y-1">
                  <dt className="text-muted-foreground">Connected by</dt>
                  <dd>
                    {device.connection_path
                      ? (pathLabel[device.connection_path] ?? device.connection_path)
                      : "—"}
                    {device.connection_detail ? (
                      <span className="text-muted-foreground"> · {device.connection_detail}</span>
                    ) : null}
                  </dd>
                  <dt className="text-muted-foreground">Signal</dt>
                  <dd className={device.link_quality !== null && device.link_quality < 30 ? "text-destructive" : ""}>
                    {device.link_quality !== null ? `${device.link_quality} %` : "—"}
                  </dd>
                  <dt className="text-muted-foreground">Last check-in</dt>
                  <dd>{age === null ? "never" : `${age} min ago`}</dd>
                  <dt className="text-muted-foreground">Model</dt>
                  <dd>{device.pi_model ?? "—"}</dd>
                  <dt className="text-muted-foreground">Tailscale</dt>
                  <dd className="font-mono text-xs">{device.tailscale_ip ?? "—"}</dd>
                  <dt className="text-muted-foreground">Temperature</dt>
                  <dd className={temp !== undefined && temp > 70 ? "text-destructive" : ""}>
                    {temp !== undefined ? `${temp} C` : "—"}
                  </dd>
                  <dt className="text-muted-foreground">Free memory</dt>
                  <dd>
                    {device.last_status?.mem_free_mb !== undefined
                      ? `${device.last_status.mem_free_mb} MB`
                      : "—"}
                  </dd>
                </dl>
                <Button
                  variant={device.enabled ? "outline" : "default"}
                  size="sm"
                  disabled={setEnabled.isPending}
                  onClick={() =>
                    setEnabled.mutate({ deviceId: device.device_id, enabled: !device.enabled })
                  }
                >
                  {device.enabled ? "Disable box" : "Enable box"}
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent admin actions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {(audit.data ?? []).length === 0 ? (
            <p className="text-muted-foreground">Nothing recorded yet.</p>
          ) : (
            (audit.data ?? []).map((entry) => (
              <p key={entry.id} className="text-muted-foreground">
                <span className="text-foreground">{entry.actor_email ?? "unknown"}</span>{" "}
                {entry.action}d <span className="font-mono">{entry.device_id}</span> —{" "}
                {new Date(entry.created_at).toLocaleString("en-GB")}
              </p>
            ))
          )}
        </CardContent>
      </Card>
    </main>
  );
}
