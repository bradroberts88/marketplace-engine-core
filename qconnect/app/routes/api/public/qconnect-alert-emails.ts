// Alert email dispatcher — drop into src/routes/api/public/qconnect-alert-emails.ts
// of the QConnect Fleet Manager app.
//
// Called once a minute (pg_cron, or any scheduler) with the shared cron secret.
// It takes the alerts that have not been emailed yet, sends one message per
// alert and marks them, so a restart can never send the same alert twice.
//
// Email needs a verified sending domain. Until one exists the dashboard still
// shows every alert; only the email leg is skipped.
import { createFileRoute } from "@tanstack/react-router";

type PendingAlert = {
  id: string;
  device_id: string | null;
  kind: string;
  severity: string;
  title: string;
  detail: string | null;
  occurrences: number;
  opened_at: string;
};

const unauthorized = () => new Response("Unauthorized", { status: 401 });

export const Route = createFileRoute("/api/public/qconnect-alert-emails")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env["LOVABLE_CRON_SECRET"];
        const provided = request.headers.get("x-cron-secret");
        if (!secret || provided !== secret) return unauthorized();

        const recipient = process.env["QCONNECT_ALERT_EMAIL"];
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { sendTemplateEmail } = await import("@/lib/email-templates/send-email");

        const { data, error } = await supabaseAdmin.rpc("qconnect_pending_alert_emails", {
          p_limit: 20,
        });
        if (error) return new Response(error.message, { status: 500 });

        const pending = (Array.isArray(data) ? data : []) as PendingAlert[];
        if (pending.length === 0 || !recipient) {
          return Response.json({ sent: 0, pending: pending.length });
        }

        const sentIds: string[] = [];
        for (const alert of pending) {
          try {
            await sendTemplateEmail("qconnect-alert", recipient, {
              templateData: {
                title: alert.title,
                detail: alert.detail ?? "",
                deviceId: alert.device_id ?? "Fleet",
                severity: alert.severity,
                occurrences: alert.occurrences,
              },
              idempotencyKey: `qconnect-alert-${alert.id}`,
            });
            sentIds.push(alert.id);
          } catch {
            // Leave it unmarked: the next run picks it up again.
          }
        }

        if (sentIds.length > 0) {
          await supabaseAdmin.rpc("qconnect_mark_alert_emailed", { p_ids: sentIds });
        }
        return Response.json({ sent: sentIds.length, pending: pending.length });
      },
    },
  },
});
