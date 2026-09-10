import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

/*
 * Device heartbeat ingestion. Called by the connector agent on the Pi or the
 * Windows unit, not by the browser. The caller is authenticated by its own
 * device token, which is compared against the stored SHA-256 hash — the plain
 * token exists only on the device and in the one-time registration response.
 */

const heartbeatSchema = z.object({
  deviceToken: z.string().min(32).max(200),
  status: z.enum(["online", "offline"]).default("online"),
  agentVersion: z.string().max(60).optional(),
  imageVersion: z.string().max(60).optional(),
  publicIp: z.string().max(64).optional(),
  latencyMs: z.number().int().min(0).max(600000).optional(),
  event: z
    .object({
      type: z.string().min(1).max(60),
      severity: z.enum(["info", "warning", "error"]).default("info"),
      message: z.string().max(1000).optional(),
      payload: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export const Route = createFileRoute("/api/public/device-heartbeat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let parsed: z.infer<typeof heartbeatSchema>;
        try {
          parsed = heartbeatSchema.parse(await request.json());
        } catch {
          return json({ error: "invalid_payload" }, 400);
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const tokenHash = await sha256Hex(parsed.deviceToken);

        const { data: device, error } = await supabaseAdmin
          .from("devices")
          .select("id, dealership_id, status")
          .eq("device_token_hash", tokenHash)
          .maybeSingle();

        if (error) return json({ error: "lookup_failed" }, 500);
        if (!device) return json({ error: "unknown_device" }, 401);
        if (device.status === "retired") return json({ error: "device_retired" }, 403);

        const now = new Date().toISOString();
        const { error: updateError } = await supabaseAdmin
          .from("devices")
          .update({
            status: parsed.status,
            last_heartbeat_at: now,
            agent_version: parsed.agentVersion ?? undefined,
            image_version: parsed.imageVersion ?? undefined,
            public_ip: parsed.publicIp ?? undefined,
            latency_ms: parsed.latencyMs ?? undefined,
            claimed_at: device.status === "unclaimed" ? now : undefined,
          })
          .eq("id", device.id);

        if (updateError) return json({ error: "update_failed" }, 500);

        await supabaseAdmin.from("device_events").insert({
          device_id: device.id,
          dealership_id: device.dealership_id,
          event_type: parsed.event?.type ?? "heartbeat",
          severity: parsed.event?.severity ?? "info",
          message: parsed.event?.message ?? null,
          payload: (parsed.event?.payload ?? {}) as Record<string, unknown>,
        });

        return json({ ok: true, deviceId: device.id, receivedAt: now });
      },
    },
  },
});
