import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'

import { sendTemplateEmail } from '@/lib/email-templates/send-email'

// Receives fleet alerts (failed bench steps, missed heartbeats, key expiry,
// admin actions) from the QConnect backend workers and emails the operator.
// Authenticated with a shared bearer secret — never expose to the browser.

const alertSchema = z.object({
  alertId: z.string().min(1),
  deviceId: z.string().min(1),
  alertType: z.string().min(1),
  severity: z.enum(['critical', 'warning', 'info']).default('warning'),
  message: z.string().min(1).max(500),
  detail: z.string().max(2000).optional(),
  occurredAt: z.string().max(100).optional(),
})

export const Route = createFileRoute('/api/public/qconnect/device-alert')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env['QCONNECT_ALERT_SECRET']
        if (!secret) {
          return Response.json({ error: 'Not configured' }, { status: 503 })
        }
        const auth = request.headers.get('authorization')
        if (auth !== `Bearer ${secret}`) {
          return Response.json({ error: 'Unauthorized' }, { status: 401 })
        }

        let body: unknown
        try {
          body = await request.json()
        } catch {
          return Response.json({ error: 'Invalid JSON' }, { status: 400 })
        }
        const parsed = alertSchema.safeParse(body)
        if (!parsed.success) {
          return Response.json(
            { error: 'Invalid alert payload' },
            { status: 400 }
          )
        }
        const alert = parsed.data

        // Fixed recipient is set on the template; empty string is unused.
        const result = await sendTemplateEmail('device-alert', '', {
          templateData: {
            deviceId: alert.deviceId,
            alertType: alert.alertType,
            severity: alert.severity,
            message: alert.message,
            detail: alert.detail,
            occurredAt: alert.occurredAt,
          },
          idempotencyKey: `device-alert-${alert.alertId}`,
        })

        return Response.json({ sent: result.sent })
      },
    },
  },
})
