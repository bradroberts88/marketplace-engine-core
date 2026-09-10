import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/* ------------------------------------------------------------------ types */

export type FleetSummary = {
  dealerships: number;
  devicesTotal: number;
  devicesOnline: number;
  listingsPosted: number;
  paymentsPaidCents: number;
  paymentsOutstandingCents: number;
};

/* --------------------------------------------------------------- schemas */

const uuid = z.string().uuid();

const dealershipInput = z.object({
  name: z.string().min(1).max(120),
  slug: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9-]+$/, "Use lowercase letters, numbers and dashes only"),
  contactEmail: z.string().email().nullable().optional(),
  city: z.string().max(120).nullable().optional(),
  region: z.string().max(120).nullable().optional(),
  monthlyPriceCents: z.number().int().min(0).default(0),
});

const listingInput = z.object({
  dealershipId: uuid,
  title: z.string().min(1).max(200),
  description: z.string().max(5000).nullable().optional(),
  vin: z.string().max(32).nullable().optional(),
  make: z.string().max(60).nullable().optional(),
  model: z.string().max(60).nullable().optional(),
  modelYear: z.number().int().min(1900).max(2100).nullable().optional(),
  mileageKm: z.number().int().min(0).nullable().optional(),
  priceCents: z.number().int().min(0),
  currency: z.string().length(3).default("EUR"),
});

const paymentInput = z.object({
  dealershipId: uuid,
  amountCents: z.number().int(),
  currency: z.string().length(3).default("EUR"),
  status: z.enum(["pending", "paid", "failed", "refunded"]).default("pending"),
  method: z.string().max(60).nullable().optional(),
  reference: z.string().max(120).nullable().optional(),
  periodStart: z.string().nullable().optional(),
  periodEnd: z.string().nullable().optional(),
  dueAt: z.string().nullable().optional(),
});

const listQuery = z
  .object({
    dealershipId: uuid.optional(),
    limit: z.number().int().min(1).max(200).default(50),
  })
  .default({ limit: 50 });

/* ----------------------------------------------------------------- reads */
/* Row visibility is decided by the database policies, not here: admins see
 * the whole fleet, staff only their own dealership. */

export const getFleetSummary = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<FleetSummary> => {
    const { supabase } = context;
    const staleAfter = new Date(Date.now() - 90_000).toISOString();

    const [dealerships, devices, online, listings, payments] = await Promise.all([
      supabase.from("dealerships").select("id", { count: "exact", head: true }),
      supabase.from("devices").select("id", { count: "exact", head: true }),
      supabase
        .from("devices")
        .select("id", { count: "exact", head: true })
        .gte("last_heartbeat_at", staleAfter),
      supabase
        .from("listings")
        .select("id", { count: "exact", head: true })
        .eq("status", "posted"),
      supabase.from("payments").select("amount_cents, status"),
    ]);

    const rows = payments.data ?? [];
    const sum = (statuses: string[]) =>
      rows
        .filter((r) => statuses.includes(r.status))
        .reduce((total, r) => total + r.amount_cents, 0);

    return {
      dealerships: dealerships.count ?? 0,
      devicesTotal: devices.count ?? 0,
      devicesOnline: online.count ?? 0,
      listingsPosted: listings.count ?? 0,
      paymentsPaidCents: sum(["paid"]),
      paymentsOutstandingCents: sum(["pending", "failed"]),
    };
  });

export const listDealerships = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("dealerships")
      .select("*")
      .order("name");
    if (error) throw new Error(error.message);
    return data;
  });

export const listDevices = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => listQuery.parse(input))
  .handler(async ({ data, context }) => {
    let query = context.supabase
      .from("devices")
      .select("*, dealerships(name)")
      .order("last_heartbeat_at", { ascending: false, nullsFirst: false })
      .limit(data.limit);
    if (data.dealershipId) query = query.eq("dealership_id", data.dealershipId);
    const { data: rows, error } = await query;
    if (error) throw new Error(error.message);
    return rows;
  });

export const listDeviceEvents = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ deviceId: uuid.optional(), limit: z.number().int().min(1).max(200).default(50) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    let query = context.supabase
      .from("device_events")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (data.deviceId) query = query.eq("device_id", data.deviceId);
    const { data: rows, error } = await query;
    if (error) throw new Error(error.message);
    return rows;
  });

export const listListings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => listQuery.parse(input))
  .handler(async ({ data, context }) => {
    let query = context.supabase
      .from("listings")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (data.dealershipId) query = query.eq("dealership_id", data.dealershipId);
    const { data: rows, error } = await query;
    if (error) throw new Error(error.message);
    return rows;
  });

export const listPayments = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => listQuery.parse(input))
  .handler(async ({ data, context }) => {
    let query = context.supabase
      .from("payments")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (data.dealershipId) query = query.eq("dealership_id", data.dealershipId);
    const { data: rows, error } = await query;
    if (error) throw new Error(error.message);
    return rows;
  });

/* ------------------------------------------------------------- mutations */
/* These succeed only for admins — the write policies enforce it. */

export const createDealership = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => dealershipInput.parse(input))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("dealerships")
      .insert({
        name: data.name,
        slug: data.slug,
        contact_email: data.contactEmail ?? null,
        city: data.city ?? null,
        region: data.region ?? null,
        monthly_price_cents: data.monthlyPriceCents,
      })
      .select()
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

export const createListing = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => listingInput.parse(input))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("listings")
      .insert({
        dealership_id: data.dealershipId,
        title: data.title,
        description: data.description ?? null,
        vin: data.vin ?? null,
        make: data.make ?? null,
        model: data.model ?? null,
        model_year: data.modelYear ?? null,
        mileage_km: data.mileageKm ?? null,
        price_cents: data.priceCents,
        currency: data.currency,
      })
      .select()
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

export const updateListingStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        id: uuid,
        status: z.enum(["draft", "queued", "posted", "paused", "sold", "removed", "failed"]),
        externalListingId: z.string().max(120).nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const now = new Date().toISOString();
    const { data: row, error } = await context.supabase
      .from("listings")
      .update({
        status: data.status,
        external_listing_id: data.externalListingId ?? null,
        posted_at: data.status === "posted" ? now : null,
        sold_at: data.status === "sold" ? now : null,
      })
      .eq("id", data.id)
      .select()
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

export const recordPayment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => paymentInput.parse(input))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("payments")
      .insert({
        dealership_id: data.dealershipId,
        amount_cents: data.amountCents,
        currency: data.currency,
        status: data.status,
        method: data.method ?? null,
        reference: data.reference ?? null,
        period_start: data.periodStart ?? null,
        period_end: data.periodEnd ?? null,
        due_at: data.dueAt ?? null,
        paid_at: data.status === "paid" ? new Date().toISOString() : null,
      })
      .select()
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

/**
 * Registers a device and returns its one-time plain token. The token is stored
 * only as a SHA-256 hash, so this response is the single chance to copy it —
 * it is injected onto the card at flash time.
 */
export const registerDevice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        dealershipId: uuid.nullable().optional(),
        label: z.string().min(1).max(120),
        kind: z.enum(["pi_zerow", "pi4", "windows"]).default("pi_zerow"),
        serial: z.string().max(120).nullable().optional(),
        imageVersion: z.string().max(60).nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    const tokenHash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");

    const { data: row, error } = await context.supabase
      .from("devices")
      .insert({
        dealership_id: data.dealershipId ?? null,
        label: data.label,
        kind: data.kind,
        serial: data.serial ?? null,
        image_version: data.imageVersion ?? null,
        device_token_hash: tokenHash,
      })
      .select("id, label, kind, status")
      .single();
    if (error) throw new Error(error.message);

    return { device: row, deviceToken: token };
  });
