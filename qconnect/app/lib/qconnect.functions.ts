// QConnect fleet data access — drop into src/lib/ of the QConnect Fleet Manager app.
//
// Every read goes through the token-free qconnect_fleet view and every write
// goes through a SECURITY DEFINER RPC that re-checks admin rights server-side,
// so a route guard is never the only thing standing between a user and a box.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export type FleetDevice = {
  device_id: string;
  dealer_id: string;
  tailscale_ip: string | null;
  enabled: boolean;
  online: boolean;
  registered_at: string | null;
  last_seen_at: string | null;
  last_status: {
    temp_c?: number;
    disk_free_mb?: number;
    mem_free_mb?: number;
    uptime_s?: number;
    tailscale_ip?: string;
  } | null;
};

export type AuditEntry = {
  id: number;
  actor_email: string | null;
  device_id: string | null;
  action: string;
  created_at: string;
};

const rows = <T,>(data: unknown): T[] => (Array.isArray(data) ? (data as T[]) : []);

export const listFleet = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("qconnect_fleet")
      .select("*")
      .order("device_id");
    if (error) throw new Error(error.message);
    return rows<FleetDevice>(data);
  });

export const listAudit = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("qconnect_audit")
      .select("id, actor_email, device_id, action, created_at")
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return rows<AuditEntry>(data);
  });

export const setDeviceEnabled = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ deviceId: z.string().min(1), enabled: z.boolean() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    // The RPC raises "not authorized" for anyone whose JWT is not an admin.
    const { error } = await context.supabase.rpc("qconnect_set_enabled", {
      p_device_id: data.deviceId,
      p_enabled: data.enabled,
    });
    if (error) throw new Error(error.message);
    return { deviceId: data.deviceId, enabled: data.enabled };
  });

export const startBenchRun = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        deviceId: z.string().min(1),
        operator: z.string().optional(),
        hardware: z.string().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: runId, error } = await context.supabase.rpc("qconnect_bench_start", {
      p_device_id: data.deviceId,
      p_operator: data.operator ?? null,
      p_hardware: data.hardware ?? null,
    });
    if (error) throw new Error(error.message);
    return { runId: runId as string };
  });

export const listBenchChecks = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ runId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: checks, error } = await context.supabase
      .from("qconnect_bench_checks")
      .select("id, phase, step, label, passed, note, checked_at")
      .eq("run_id", data.runId)
      .order("phase")
      .order("step");
    if (error) throw new Error(error.message);
    return rows<{
      id: string;
      phase: number;
      step: string;
      label: string;
      passed: boolean | null;
      note: string | null;
      checked_at: string | null;
    }>(checks);
  });

export const recordBenchCheck = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        checkId: z.string().uuid(),
        passed: z.boolean().nullable(),
        note: z.string().max(500).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("qconnect_bench_checks")
      .update({
        passed: data.passed,
        note: data.note ?? null,
        checked_at: data.passed === null ? null : new Date().toISOString(),
      })
      .eq("id", data.checkId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const finishBenchRun = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ runId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: verdict, error } = await context.supabase.rpc("qconnect_bench_finish", {
      p_run_id: data.runId,
    });
    if (error) throw new Error(error.message);
    return { verdict: verdict as "go" | "no_go" };
  });
