// QConnect operations data access — alerts, remote instructions, onboarding
// timeline and software releases. Drop into src/lib/ of the QConnect Fleet
// Manager app alongside qconnect.functions.ts.
//
// Every write goes through a SECURITY DEFINER RPC that re-checks admin rights
// in the database, so the route guard is never the only protection.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export type AlertSeverity = "info" | "warning" | "critical";

export type AlertKind =
  | "step_overdue"
  | "step_failed"
  | "device_silent"
  | "command_expired"
  | "update_failed";

export type FleetAlert = {
  id: string;
  device_id: string | null;
  dealer_id: string | null;
  kind: AlertKind;
  severity: AlertSeverity;
  title: string;
  detail: string | null;
  occurrences: number;
  opened_at: string;
  last_seen_at: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
};

export type StepStatus = "pending" | "passed" | "failed" | "overdue" | "skipped";

export type OnboardingStep = {
  run_id: string;
  device_id: string;
  state: "in_progress" | "complete" | "failed";
  step: string;
  ordinal: number;
  label: string;
  status: StepStatus;
  due_at: string;
  reported_at: string | null;
  detail: string | null;
};

export type DeviceCommand = {
  id: string;
  device_id: string;
  kind: string;
  payload: Record<string, unknown>;
  status: "queued" | "sent" | "done" | "failed" | "expired";
  attempts: number;
  issued_email: string | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
};

export type Release = {
  version: string;
  channel: string;
  bundle_url: string;
  sha256: string;
  notes: string | null;
  published: boolean;
  created_at: string;
};

export type Rollout = {
  id: string;
  version: string;
  scope_kind: "all" | "dealer" | "device";
  scope_value: string | null;
  percent: number;
  active: boolean;
  created_at: string;
};

export const COMMAND_KINDS = [
  "restart_agent",
  "rerun_setup",
  "reboot",
  "reconnect",
  "force_path",
  "set_wifi",
  "set_apn",
  "collect_logs",
  "update_agent",
] as const;

export type CommandKind = (typeof COMMAND_KINDS)[number];

const rows = <T,>(data: unknown): T[] => (Array.isArray(data) ? (data as T[]) : []);

// ------------------------------------------------------------------- alerts
export const listAlerts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ includeResolved: z.boolean().default(false) }).parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    let query = context.supabase
      .from("qconnect_alerts")
      .select(
        "id, device_id, dealer_id, kind, severity, title, detail, occurrences, opened_at, last_seen_at, acknowledged_at, resolved_at",
      )
      .order("opened_at", { ascending: false })
      .limit(200);
    if (!data.includeResolved) {
      query = query.is("resolved_at", null);
    }
    const { data: result, error } = await query;
    if (error) throw new Error(error.message);
    return rows<FleetAlert>(result);
  });

export const acknowledgeAlert = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ alertId: z.string().uuid(), resolve: z.boolean().default(false) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.rpc("qconnect_ack_alert", {
      p_alert_id: data.alertId,
      p_resolve: data.resolve,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// -------------------------------------------------------- onboarding timeline
export const listOnboarding = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ deviceId: z.string().min(1) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: result, error } = await context.supabase
      .from("qconnect_onboarding")
      .select("run_id, device_id, state, step, ordinal, label, status, due_at, reported_at, detail")
      .eq("device_id", data.deviceId)
      .order("ordinal");
    if (error) throw new Error(error.message);
    return rows<OnboardingStep>(result);
  });

// ----------------------------------------------------------------- commands
export const listCommands = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ deviceId: z.string().min(1).optional() }).parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    let query = context.supabase
      .from("qconnect_commands")
      .select(
        "id, device_id, kind, payload, status, attempts, issued_email, error, created_at, finished_at",
      )
      .order("created_at", { ascending: false })
      .limit(100);
    if (data.deviceId) query = query.eq("device_id", data.deviceId);
    const { data: result, error } = await query;
    if (error) throw new Error(error.message);
    return rows<DeviceCommand>(result);
  });

export const issueCommand = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        deviceId: z.string().min(1),
        kind: z.enum(COMMAND_KINDS),
        payload: z.record(z.string(), z.unknown()).default({}),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: result, error } = await context.supabase.rpc("qconnect_issue_command", {
      p_device_id: data.deviceId,
      p_kind: data.kind,
      p_payload: data.payload,
    });
    if (error) throw new Error(error.message);
    return { commandId: result as string };
  });

// ----------------------------------------------------------------- releases
export const listReleases = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("qconnect_releases")
      .select("version, channel, bundle_url, sha256, notes, published, created_at")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return rows<Release>(data);
  });

export const listRollouts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("qconnect_rollouts")
      .select("id, version, scope_kind, scope_value, percent, active, created_at")
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return rows<Rollout>(data);
  });

export const publishRelease = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        version: z.string().min(1).max(64),
        bundleUrl: z.string().url(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/, "Expected a 64-character SHA-256 value"),
        signature: z.string().min(1),
        notes: z.string().max(1000).optional(),
        channel: z.string().min(1).max(32).default("stable"),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.rpc("qconnect_publish_release", {
      p_version: data.version,
      p_bundle_url: data.bundleUrl,
      p_sha256: data.sha256,
      p_signature: data.signature,
      p_notes: data.notes ?? null,
      p_channel: data.channel,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const startRollout = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        version: z.string().min(1),
        scopeKind: z.enum(["all", "dealer", "device"]).default("all"),
        scopeValue: z.string().optional(),
        percent: z.number().int().min(1).max(100).default(100),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.rpc("qconnect_start_rollout", {
      p_version: data.version,
      p_scope_kind: data.scopeKind,
      p_scope_value: data.scopeValue ?? null,
      p_percent: data.percent,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const stopRollout = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ version: z.string().min(1) }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.rpc("qconnect_stop_rollout", {
      p_version: data.version,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ----------------------------------------------------------------- card keys
// One remote-access key per card. The screen shows which key went onto which
// box, how long it has left, and lets an administrator retire one.
export type CardKeyState =
  | "ok"
  | "expiring soon"
  | "expired"
  | "revoked"
  | "unrecorded"
  | "no expiry recorded";

export type CardKey = {
  device_id: string;
  dealer_id: string | null;
  tailscale_ip: string | null;
  tailscale_key_id: string | null;
  tailscale_key_issued_at: string | null;
  tailscale_key_expires_at: string | null;
  tailscale_key_revoked_at: string | null;
  registered_at: string | null;
  last_seen_at: string | null;
  key_state: CardKeyState;
  days_left: number | null;
};

export const listCardKeys = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("qconnect_keys")
      .select("*")
      .order("tailscale_key_expires_at", { ascending: true, nullsFirst: false });
    if (error) throw new Error(error.message);
    return rows<CardKey>(data);
  });

export const revokeCardKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ deviceId: z.string().min(1) }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.rpc("qconnect_mark_key_revoked", {
      p_device_id: data.deviceId,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ------------------------------------------------------- batch connectivity
// The bench tracker, filled in by the cards themselves. For every card we keep
// the newest result per connection path, so the grid answers "did cable, Wi-Fi
// and the AT&T SIM each work on this card?" without anyone typing anything.
export type PathResult = {
  reason: string;
  label: string;
  detail: string | null;
  at: string;
  ok: boolean;
};

export type BatchCard = {
  device_id: string;
  dealer_id: string | null;
  online: boolean;
  health: string;
  last_seen_at: string | null;
  ethernet: PathResult | null;
  wifi: PathResult | null;
  cellular: PathResult | null;
};

type NetEventRow = {
  device_id: string;
  path: string | null;
  reason: string;
  detail: string | null;
  created_at: string;
};

type FleetRow = {
  device_id: string;
  dealer_id: string | null;
  online: boolean;
  health: string;
  last_seen_at: string | null;
};

export const listBatchConnectivity = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const fleet = await context.supabase
      .from("qconnect_fleet")
      .select("device_id, dealer_id, online, health, last_seen_at")
      .order("device_id");
    if (fleet.error) throw new Error(fleet.error.message);

    const events = await context.supabase
      .from("qconnect_net_events")
      .select("device_id, path, reason, detail, created_at")
      .in("path", ["ethernet", "wifi", "cellular"])
      .order("created_at", { ascending: false })
      .limit(1000);
    if (events.error) throw new Error(events.error.message);

    // Plain-English wording, identical to qconnect_net_reason_label in the
    // database, so the bench sheet and the screen never disagree.
    const labels: Record<string, string> = {
      ok: "Connected",
      wrong_password: "Wi-Fi password was not accepted",
      ssid_not_in_range: "Wi-Fi network not found",
      ssid_not_in_range_2g_radio: "Wi-Fi network not found (this box is 2.4 GHz only)",
      joined_but_no_internet: "Joined the network but there is no internet behind it",
      captive_portal: "Network shows a sign-in page",
      cellular_sim_locked: "SIM is PIN-locked",
      cellular_sim_disabled: "SIM or modem radio is switched off",
      cellular_no_tower: "Modem cannot see a mobile tower",
      cellular_no_apn: "Modem fitted but no mobile APN set",
      cellular_failed: "Mobile data did not connect",
      netmanager_unavailable: "The box network service is not running",
      no_path: "No cable, no known Wi-Fi, no modem",
      no_wifi_radio: "No Wi-Fi radio found on this box",
    };

    const newest = new Map<string, PathResult>();
    for (const event of rows<NetEventRow>(events.data)) {
      const key = `${event.device_id}|${event.path}`;
      if (newest.has(key)) continue; // already have a newer one
      newest.set(key, {
        reason: event.reason,
        label: labels[event.reason] ?? event.reason,
        detail: event.detail,
        at: event.created_at,
        ok: event.reason === "ok",
      });
    }

    return rows<FleetRow>(fleet.data).map<BatchCard>((device) => ({
      device_id: device.device_id,
      dealer_id: device.dealer_id,
      online: device.online,
      health: device.health,
      last_seen_at: device.last_seen_at,
      ethernet: newest.get(`${device.device_id}|ethernet`) ?? null,
      wifi: newest.get(`${device.device_id}|wifi`) ?? null,
      cellular: newest.get(`${device.device_id}|cellular`) ?? null,
    }));
  });
