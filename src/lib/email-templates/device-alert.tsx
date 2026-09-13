import * as React from 'react'

import {
  Body,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  Text,
} from '@react-email/components'

import type { TemplateEntry } from './registry'

interface DeviceAlertEmailProps {
  deviceId?: string
  alertType?: string
  severity?: string
  message?: string
  detail?: string
  occurredAt?: string
}

const severityColors: Record<string, string> = {
  critical: '#b91c1c',
  warning: '#b45309',
  info: '#1d4ed8',
}

const DeviceAlertEmail = ({
  deviceId,
  alertType,
  severity,
  message,
  detail,
  occurredAt,
}: DeviceAlertEmailProps) => {
  const severityLabel = severity ?? 'warning'
  const badgeColor = severityColors[severityLabel] ?? severityColors['warning']

  return (
    <Html lang="en" dir="ltr">
      <Head />
      <Preview>
        Pi alert: {message ?? 'a device needs attention'}
      </Preview>
      <Body style={main}>
        <Container style={container}>
          <Text style={brand}>QConnect fleet</Text>
          <Heading style={h1}>A Pi needs attention</Heading>
          <Text style={{ ...badge, backgroundColor: badgeColor }}>
            {severityLabel.toUpperCase()}
          </Text>
          <Text style={text}>
            <strong>{message ?? 'Something needs a look.'}</strong>
          </Text>
          {deviceId ? (
            <Text style={text}>
              Card: <strong>{deviceId}</strong>
            </Text>
          ) : null}
          {alertType ? <Text style={text}>Kind: {alertType}</Text> : null}
          {occurredAt ? <Text style={text}>When: {occurredAt}</Text> : null}
          {detail ? (
            <>
              <Hr style={rule} />
              <Text style={detailText}>{detail}</Text>
            </>
          ) : null}
          <Text style={footer}>
            You are receiving this because you run the QConnect fleet. Open the
            fleet dashboard to see the card and clear the alert.
          </Text>
        </Container>
      </Body>
    </Html>
  )
}

export const template = {
  component: DeviceAlertEmail,
  subject: (data: Record<string, unknown>) =>
    `Pi alert${data.deviceId ? ` — ${String(data.deviceId)}` : ''}: ${String(
      data.message ?? 'device needs attention'
    )}`,
  displayName: 'Pi fleet alert',
  previewData: {
    deviceId: 'qc-card-001',
    alertType: 'Heartbeat missed',
    severity: 'critical',
    message: 'This card has not checked in for over an hour',
    detail: 'Last seen on Wi-Fi. Check power and the internet connection.',
    occurredAt: '13/09/2026 07:30',
  },
  to: 'support@quantumconnectai.com',
} satisfies TemplateEntry

const main = { backgroundColor: '#ffffff', fontFamily: 'Arial, sans-serif' }
const container = { padding: '20px 25px' }
const brand = {
  fontSize: '13px',
  fontWeight: 'bold' as const,
  letterSpacing: '1px',
  textTransform: 'uppercase' as const,
  color: '#ED5F18',
  margin: '0 0 16px',
}
const h1 = {
  fontSize: '22px',
  fontWeight: 'bold' as const,
  color: '#000000',
  margin: '0 0 16px',
}
const badge = {
  display: 'inline-block',
  color: '#ffffff',
  fontSize: '11px',
  fontWeight: 'bold' as const,
  letterSpacing: '1px',
  borderRadius: '4px',
  padding: '4px 8px',
  margin: '0 0 16px',
}
const text = {
  fontSize: '14px',
  color: '#55575d',
  lineHeight: '1.5',
  margin: '0 0 12px',
}
const rule = { borderColor: '#e5e5e5', margin: '16px 0' }
const detailText = {
  fontSize: '13px',
  color: '#55575d',
  lineHeight: '1.5',
  margin: '0 0 12px',
}
const footer = { fontSize: '12px', color: '#999999', margin: '30px 0 0' }
