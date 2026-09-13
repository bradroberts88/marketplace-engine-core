// Alert email — drop into src/lib/email-templates/qconnect-alert.tsx of the
// QConnect Fleet Manager app and register it in registry.ts as "qconnect-alert".
import React from "react";
import { Body, Container, Head, Heading, Html, Preview, Section, Text } from "@react-email/components";
import type { TemplateEntry } from "./registry";

interface Props {
  title?: string;
  detail?: string;
  deviceId?: string;
  severity?: string;
  occurrences?: number;
}

const Email = ({ title, detail, deviceId, severity, occurrences }: Props) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>{title ?? "A box needs attention"}</Preview>
    <Body style={main}>
      <Container style={container}>
        <Heading style={heading}>{title ?? "A box needs attention"}</Heading>
        <Section style={box}>
          <Text style={line}>
            <strong>Box:</strong> {deviceId ?? "Unknown"}
          </Text>
          <Text style={line}>
            <strong>Priority:</strong> {severity === "critical" ? "Urgent" : "Worth a look"}
          </Text>
          {occurrences && occurrences > 1 ? (
            <Text style={line}>
              <strong>Seen:</strong> {occurrences} times
            </Text>
          ) : null}
        </Section>
        <Text style={body}>{detail ?? "Open the alerts page for the full picture."}</Text>
        <Text style={footer}>Open the alerts page in QConnect Fleet Manager to acknowledge it.</Text>
      </Container>
    </Body>
  </Html>
);

export const template = {
  component: Email,
  subject: "QConnect: a box needs attention",
  displayName: "Fleet alert",
  previewData: {
    title: "Box has stopped checking in",
    detail: "Last check-in 13/09/2026 09:41 over wifi.",
    deviceId: "QCN-0142",
    severity: "critical",
    occurrences: 3,
  },
} satisfies TemplateEntry;

const main = { backgroundColor: "#ffffff", fontFamily: "Arial, sans-serif" };
const container = { padding: "24px 28px", maxWidth: "560px" };
const heading = { fontSize: "20px", margin: "0 0 16px" };
const box = { backgroundColor: "#f5f6f8", borderRadius: "8px", padding: "12px 16px" };
const line = { fontSize: "14px", margin: "4px 0" };
const body = { fontSize: "15px", lineHeight: "22px", margin: "16px 0" };
const footer = { fontSize: "13px", color: "#6b7280", margin: "24px 0 0" };
