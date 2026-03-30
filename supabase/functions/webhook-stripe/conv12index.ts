// ============================================
// NOD — webhook-stripe/index.ts
// Conversation 10: Stripe Billing
//
// Handles Stripe subscription lifecycle webhooks:
//   - checkout.session.completed
//   - customer.subscription.updated
//   - customer.subscription.deleted
//   - invoice.payment_succeeded
//   - invoice.payment_failed
//
// Pipeline per event:
//   1. Verify Stripe webhook signature
//   2. Idempotency check via processed_webhook_events
//   3. Parse event → extract customer ID + subscription data
//   4. Update tenant via update_tenant_subscription() RPC
//   5. Insert processed_webhook_events row
//   6. Audit log entry
//
// No API key auth — Stripe signature verification instead.
// ============================================

import { getSupabaseClient } from "../_shared/supabase.ts";
import { insertAuditLog } from "../_shared/audit.ts";
import { alertFounder } from "../_shared/alerting.ts";
import type { SubscriptionStatus } from "../_shared/types.ts";

// ---- Plan Tier Mapping ----
// Maps Stripe price IDs to plan tiers.
// Update these when Stripe products/prices are created.

interface PlanTier {
  name: string;
  max_contacts: number;
  max_messages_per_month: number;
}

const PLAN_TIERS: Record<string, PlanTier> = {
  // Starter: 5K contacts, 10K messages
  starter: { name: "starter", max_contacts: 5000, max_messages_per_month: 10000 },
  // Professional: 25K contacts, 50K messages
  professional: { name: "professional", max_contacts: 25000, max_messages_per_month: 50000 },
  // Enterprise: unlimited
  enterprise: { name: "enterprise", max_contacts: 999999, max_messages_per_month: 999999 },
};

// Maps Stripe price IDs → plan tier keys.
// These will be set once Stripe products are created.
const PRICE_TO_TIER: Record<string, string> = {
  price_starter_monthly: "starter",
  price_starter_yearly: "starter",
  price_professional_monthly: "professional",
  price_professional_yearly: "professional",
  price_enterprise_monthly: "enterprise",
  price_enterprise_yearly: "enterprise",
};

// ---- CORS Headers ----

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, stripe-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ---- JSON Response Helpers ----

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

function errorResponse(
  error: string,
  code: string,
  status: number,
  details?: Record<string, unknown>,
): Response {
  return jsonResponse({ error, code, ...(details ? { details } : {}) }, status);
}

// ---- Stripe Signature Verification ----

async function verifyStripeSignature(
  payload: string,
  signatureHeader: string,
  secret: string,
): Promise<boolean> {
  // Parse the Stripe-Signature header
  const parts = signatureHeader.split(",");
  let timestamp = "";
  let signature = "";

  for (const part of parts) {
    const [key, value] = part.trim().split("=");
    if (key === "t") timestamp = value;
    if (key === "v1") signature = value;
  }

  if (!timestamp || !signature) return false;

  // Stripe tolerance: reject events older than 5 minutes
  const eventAge = Math.floor(Date.now() / 1000) - parseInt(timestamp, 10);
  if (isNaN(eventAge) || eventAge > 300) return false;

  // Compute expected signature: HMAC-SHA-256 of "timestamp.payload"
  const signedPayload = `${timestamp}.${payload}`;
  const encoder = new TextEncoder();

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const expectedSignature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    encoder.encode(signedPayload),
  );

  const expectedHex = Array.from(new Uint8Array(expectedSignature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Constant-time comparison
  if (expectedHex.length !== signature.length) return false;

  let mismatch = 0;
  for (let i = 0; i < expectedHex.length; i++) {
    mismatch |= expectedHex.charCodeAt(i) ^ signature.charCodeAt(i);
  }

  return mismatch === 0;
}

// ---- Plan Tier Resolution ----

function resolvePlanTier(subscription: Record<string, unknown>): PlanTier | null {
  // Try 1: Check product metadata for tier
  const items = subscription.items as Record<string, unknown> | undefined;
  if (items) {
    const data = items.data as Array<Record<string, unknown>> | undefined;
    if (data && data.length > 0) {
      const item = data[0];
      const price = item.price as Record<string, unknown> | undefined;

      if (price) {
        // Check price ID mapping
        const priceId = price.id as string | undefined;
        if (priceId && PRICE_TO_TIER[priceId]) {
          return PLAN_TIERS[PRICE_TO_TIER[priceId]];
        }

        // Check product metadata for "tier" key
        const product = price.product as Record<string, unknown> | string | undefined;
        if (product && typeof product === "object") {
          const metadata = product.metadata as Record<string, string> | undefined;
          if (metadata?.tier && PLAN_TIERS[metadata.tier]) {
            return PLAN_TIERS[metadata.tier];
          }
        }

        // Check price metadata for "tier" key
        const priceMetadata = price.metadata as Record<string, string> | undefined;
        if (priceMetadata?.tier && PLAN_TIERS[priceMetadata.tier]) {
          return PLAN_TIERS[priceMetadata.tier];
        }
      }
    }
  }

  return null;
}

// ---- Stripe Status → Nod Status Mapping ----

function mapSubscriptionStatus(stripeStatus: string): SubscriptionStatus {
  switch (stripeStatus) {
    case "trialing":
      return "trialing";
    case "active":
      return "active";
    case "past_due":
      return "past_due";
    case "canceled":
    case "cancelled":
    case "unpaid":
    case "incomplete_expired":
      return "cancelled";
    default:
      return "active";
  }
}

// ---- Tenant Lookup by Stripe Customer ID ----

async function findTenantByStripeCustomer(
  supabase: ReturnType<typeof getSupabaseClient>,
  stripeCustomerId: string,
): Promise<{ id: string; name: string } | null> {
  const { data, error } = await supabase
    .from("tenants")
    .select("id, name")
    .eq("stripe_customer_id", stripeCustomerId)
    .single();

  if (error || !data) return null;
  return data;
}

// ---- Tenant Lookup by Metadata (for checkout.session.completed) ----

async function findTenantById(
  supabase: ReturnType<typeof getSupabaseClient>,
  tenantId: string,
): Promise<{ id: string; name: string } | null> {
  const { data, error } = await supabase
    .from("tenants")
    .select("id, name")
    .eq("id", tenantId)
    .single();

  if (error || !data) return null;
  return data;
}

// ---- Supported Event Types ----

const SUPPORTED_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_succeeded",
  "invoice.payment_failed",
];

// ---- Main Handler ----

Deno.serve(async (req: Request) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Only POST allowed
  if (req.method !== "POST") {
    return errorResponse("Method not allowed", "METHOD_NOT_ALLOWED", 405);
  }

  try {
    // Step 1: Get raw payload and signature header
    const payload = await req.text();
    const signatureHeader = req.headers.get("stripe-signature");

    if (!signatureHeader) {
      return errorResponse("Missing Stripe signature", "MISSING_SIGNATURE", 400);
    }

    // Step 2: Verify webhook signature
    const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
    if (!webhookSecret) {
      console.error("STRIPE_WEBHOOK_SECRET is not configured");
      await alertFounder(
        "Stripe Webhook Secret Missing",
        "<p>STRIPE_WEBHOOK_SECRET is not configured. Webhook processing is disabled.</p>",
      );
      return errorResponse("Server configuration error", "CONFIG_ERROR", 500);
    }

    const isValid = await verifyStripeSignature(payload, signatureHeader, webhookSecret);
    if (!isValid) {
      return errorResponse("Invalid webhook signature", "INVALID_SIGNATURE", 400);
    }

    // Step 3: Parse event
    const event = JSON.parse(payload);
    const eventId: string = event.id;
    const eventType: string = event.type;

    // Skip unsupported event types (acknowledge but don't process)
    if (!SUPPORTED_EVENTS.includes(eventType)) {
      return jsonResponse({ received: true, processed: false, reason: "unsupported_event_type" });
    }

    // Step 4: Idempotency check — try to insert into processed_webhook_events
    const supabase = getSupabaseClient();

    const { error: idempotencyError } = await supabase.rpc(
      "insert_processed_webhook_event",
      {
        p_stripe_event_id: eventId,
        p_event_type: eventType,
      },
    );

    if (idempotencyError) {
      // UNIQUE violation (23505) means already processed
      if (idempotencyError.code === "23505") {
        return jsonResponse({ received: true, processed: false, reason: "already_processed" });
      }
      // Other errors — log and continue cautiously
      console.error("Idempotency insert error:", idempotencyError.message);
    }

    // Step 5: Route by event type
    const eventObject = event.data?.object as Record<string, unknown> | undefined;
    if (!eventObject) {
      return jsonResponse({ received: true, processed: false, reason: "no_event_data" });
    }

    let tenantId: string | null = null;
    let tenantName: string | null = null;
    let auditDetails: Record<string, unknown> = {};

    // ---- checkout.session.completed ----
    if (eventType === "checkout.session.completed") {
      const stripeCustomerId = eventObject.customer as string | undefined;
      const subscriptionId = eventObject.subscription as string | undefined;
      const metadata = eventObject.metadata as Record<string, string> | undefined;

      if (!stripeCustomerId) {
        return jsonResponse({ received: true, processed: false, reason: "no_customer_id" });
      }

      // Resolve tenant: first try metadata.tenant_id, then lookup by stripe_customer_id
      if (metadata?.tenant_id) {
        const tenant = await findTenantById(supabase, metadata.tenant_id);
        if (tenant) {
          tenantId = tenant.id;
          tenantName = tenant.name;
        }
      }

      if (!tenantId) {
        const tenant = await findTenantByStripeCustomer(supabase, stripeCustomerId);
        if (tenant) {
          tenantId = tenant.id;
          tenantName = tenant.name;
        }
      }

      if (!tenantId) {
        console.error("No tenant found for Stripe customer:", stripeCustomerId);
        await alertFounder(
          "Stripe Webhook: Unknown Customer",
          `<p>checkout.session.completed for Stripe customer <strong>${stripeCustomerId}</strong> but no matching tenant found.</p>`,
        );
        return jsonResponse({ received: true, processed: false, reason: "tenant_not_found" });
      }

      // Resolve plan tier from the subscription (need to fetch it)
      // For checkout.session.completed, the subscription object may be expanded or just an ID
      let planTier: PlanTier = PLAN_TIERS["starter"]; // default to starter

      // Check session metadata for tier
      if (metadata?.tier && PLAN_TIERS[metadata.tier]) {
        planTier = PLAN_TIERS[metadata.tier];
      }

      const { error: updateError } = await supabase.rpc("update_tenant_subscription", {
        p_tenant_id: tenantId,
        p_stripe_customer_id: stripeCustomerId,
        p_subscription_status: "active",
        p_subscription_expires_at: null,
        p_max_contacts: planTier.max_contacts,
        p_max_messages_per_month: planTier.max_messages_per_month,
      });

      if (updateError) {
        console.error("Failed to update tenant subscription:", updateError.message);
        await alertFounder(
          "Stripe Webhook: Update Failed",
          `<p>Failed to update tenant <strong>${tenantId}</strong> after checkout.session.completed: ${updateError.message}</p>`,
        );
        return errorResponse("Failed to process subscription", "UPDATE_FAILED", 500);
      }

      auditDetails = {
        event_type: eventType,
        stripe_event_id: eventId,
        stripe_customer_id: stripeCustomerId,
        subscription_id: subscriptionId,
        plan: planTier.name,
        status: "active",
      };
    }

    // ---- customer.subscription.updated ----
    else if (eventType === "customer.subscription.updated") {
      const stripeCustomerId = eventObject.customer as string | undefined;
      const stripeStatus = eventObject.status as string | undefined;
      const currentPeriodEnd = eventObject.current_period_end as number | undefined;

      if (!stripeCustomerId) {
        return jsonResponse({ received: true, processed: false, reason: "no_customer_id" });
      }

      const tenant = await findTenantByStripeCustomer(supabase, stripeCustomerId);
      if (!tenant) {
        console.error("No tenant found for Stripe customer:", stripeCustomerId);
        return jsonResponse({ received: true, processed: false, reason: "tenant_not_found" });
      }

      tenantId = tenant.id;
      tenantName = tenant.name;

      const nodStatus = mapSubscriptionStatus(stripeStatus ?? "active");
      const expiresAt = currentPeriodEnd
        ? new Date(currentPeriodEnd * 1000).toISOString()
        : null;

      // Resolve plan tier from subscription items
      const planTier = resolvePlanTier(eventObject);

      const { error: updateError } = await supabase.rpc("update_tenant_subscription", {
        p_tenant_id: tenantId,
        p_stripe_customer_id: stripeCustomerId,
        p_subscription_status: nodStatus,
        p_subscription_expires_at: expiresAt,
        p_max_contacts: planTier?.max_contacts ?? null,
        p_max_messages_per_month: planTier?.max_messages_per_month ?? null,
      });

      if (updateError) {
        console.error("Failed to update tenant subscription:", updateError.message);
        await alertFounder(
          "Stripe Webhook: Update Failed",
          `<p>Failed to update tenant <strong>${tenantId}</strong> after subscription.updated: ${updateError.message}</p>`,
        );
        return errorResponse("Failed to process subscription update", "UPDATE_FAILED", 500);
      }

      auditDetails = {
        event_type: eventType,
        stripe_event_id: eventId,
        stripe_customer_id: stripeCustomerId,
        status: nodStatus,
        plan: planTier?.name ?? "unchanged",
        expires_at: expiresAt,
      };
    }

    // ---- customer.subscription.deleted ----
    else if (eventType === "customer.subscription.deleted") {
      const stripeCustomerId = eventObject.customer as string | undefined;

      if (!stripeCustomerId) {
        return jsonResponse({ received: true, processed: false, reason: "no_customer_id" });
      }

      const tenant = await findTenantByStripeCustomer(supabase, stripeCustomerId);
      if (!tenant) {
        console.error("No tenant found for Stripe customer:", stripeCustomerId);
        return jsonResponse({ received: true, processed: false, reason: "tenant_not_found" });
      }

      tenantId = tenant.id;
      tenantName = tenant.name;

      const { error: updateError } = await supabase.rpc("update_tenant_subscription", {
        p_tenant_id: tenantId,
        p_stripe_customer_id: stripeCustomerId,
        p_subscription_status: "cancelled",
        p_subscription_expires_at: new Date().toISOString(),
        p_max_contacts: null,
        p_max_messages_per_month: null,
      });

      if (updateError) {
        console.error("Failed to cancel tenant subscription:", updateError.message);
        await alertFounder(
          "Stripe Webhook: Cancellation Failed",
          `<p>Failed to cancel tenant <strong>${tenantId}</strong>: ${updateError.message}</p>`,
        );
        return errorResponse("Failed to process cancellation", "UPDATE_FAILED", 500);
      }

      auditDetails = {
        event_type: eventType,
        stripe_event_id: eventId,
        stripe_customer_id: stripeCustomerId,
        status: "cancelled",
      };
    }

    // ---- invoice.payment_succeeded ----
    else if (eventType === "invoice.payment_succeeded") {
      const stripeCustomerId = eventObject.customer as string | undefined;
      const subscriptionId = eventObject.subscription as string | undefined;

      if (!stripeCustomerId) {
        return jsonResponse({ received: true, processed: false, reason: "no_customer_id" });
      }

      const tenant = await findTenantByStripeCustomer(supabase, stripeCustomerId);
      if (!tenant) {
        return jsonResponse({ received: true, processed: false, reason: "tenant_not_found" });
      }

      tenantId = tenant.id;
      tenantName = tenant.name;

      // Payment succeeded — ensure subscription is active
      const { error: updateError } = await supabase.rpc("update_tenant_subscription", {
        p_tenant_id: tenantId,
        p_stripe_customer_id: stripeCustomerId,
        p_subscription_status: "active",
        p_subscription_expires_at: null,
        p_max_contacts: null,
        p_max_messages_per_month: null,
      });

      if (updateError) {
        console.error("Failed to confirm payment:", updateError.message);
      }

      auditDetails = {
        event_type: eventType,
        stripe_event_id: eventId,
        stripe_customer_id: stripeCustomerId,
        subscription_id: subscriptionId,
        status: "active",
      };
    }

    // ---- invoice.payment_failed ----
    else if (eventType === "invoice.payment_failed") {
      const stripeCustomerId = eventObject.customer as string | undefined;
      const attemptCount = eventObject.attempt_count as number | undefined;

      if (!stripeCustomerId) {
        return jsonResponse({ received: true, processed: false, reason: "no_customer_id" });
      }

      const tenant = await findTenantByStripeCustomer(supabase, stripeCustomerId);
      if (!tenant) {
        return jsonResponse({ received: true, processed: false, reason: "tenant_not_found" });
      }

      tenantId = tenant.id;
      tenantName = tenant.name;

      // Mark as past_due
      const { error: updateError } = await supabase.rpc("update_tenant_subscription", {
        p_tenant_id: tenantId,
        p_stripe_customer_id: stripeCustomerId,
        p_subscription_status: "past_due",
        p_subscription_expires_at: null,
        p_max_contacts: null,
        p_max_messages_per_month: null,
      });

      if (updateError) {
        console.error("Failed to mark payment failed:", updateError.message);
      }

      // Alert founder on payment failure
      await alertFounder(
        `Payment Failed: ${tenantName}`,
        `<p>Invoice payment failed for <strong>${tenantName}</strong> (${tenantId}).</p>
         <p>Stripe customer: ${stripeCustomerId}</p>
         <p>Attempt count: ${attemptCount ?? "unknown"}</p>`,
      );

      auditDetails = {
        event_type: eventType,
        stripe_event_id: eventId,
        stripe_customer_id: stripeCustomerId,
        attempt_count: attemptCount,
        status: "past_due",
      };
    }

    // Step 6: Audit log entry
    if (tenantId) {
      await insertAuditLog({
        tenantId,
        action: "subscription_updated",
        entityType: "tenant",
        entityId: tenantId,
        details: auditDetails,
      });
    }

    return jsonResponse({
      received: true,
      processed: true,
      event_type: eventType,
      tenant_id: tenantId,
    });

  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Stripe webhook error:", message);

    await alertFounder(
      "Stripe Webhook Error",
      `<p>Unhandled error in webhook-stripe: ${message}</p>`,
    );

    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
});
